import { KafkaJS } from '@confluentinc/kafka-javascript';
import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

import { BadRequestError, ValidationError } from '../errors/app-error';
import { NonRetryableError } from '../errors/non-retryable.error';
import { logger } from '../logger';
import { errorType } from '../telemetry/attributes';
import { messagingProcessDuration } from '../telemetry/metrics';
import { DeadLetterStore, FailedMessage } from './dead-letters';

// Header with the company (faclab-core tenant) of a message, the same name faclab-core uses
export const TENANT_HEADER = 'faclab-tenant-id';

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
}

export interface ConsumerSettings extends Partial<RetryConfig> {
  // The consumer group, for messaging.consumer.group.name
  groupId?: string;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = { maxRetries: 3, baseDelayMs: 1000 };

function isRetryable(error: unknown): boolean {
  if (error instanceof NonRetryableError) return false;
  if (error instanceof BadRequestError) return false;
  if (error instanceof ValidationError) return false;
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function calculateBackoff(attempt: number, baseDelayMs: number): number {
  const delay = baseDelayMs * Math.pow(2, attempt);
  const jitter = 0.75 + Math.random() * 0.5;
  return delay * jitter;
}

const tracer = trace.getTracer('faclab-invoicing.kafka');

/**
 * How every consumer of the service joins its group. It commits by hand, after processing. A
 * partition without a committed offset is read from the beginning, like faclab-core's consumer: the
 * default (only new messages) loses what arrives while the service is down, such as the first message
 * of a new topic or of a company in a partition. Handlers are idempotent, so reading again is safe.
 */
export const consumerOptions = (groupId: string) => ({
  groupId,
  autoCommit: false,
  fromBeginning: true,
});

export abstract class BaseKafkaConsumer {
  private retryConfig: RetryConfig;
  private groupId: string | undefined;

  constructor(
    private consumer: KafkaJS.Consumer,
    private topics: string[],
    private deadLetters: DeadLetterStore,
    { groupId, ...retryConfig }: ConsumerSettings = {},
  ) {
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
    this.groupId = groupId;
  }

  protected abstract handleMessage(topic: string, message: string): Promise<void>;

  async start(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({ topics: this.topics });

    await this.consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        if (!message.value) return;

        const value = message.value.toString();

        const headers: Record<string, string> = {};
        if (message.headers) {
          for (const [k, v] of Object.entries(message.headers)) {
            if (v) headers[k] = Buffer.isBuffer(v) ? v.toString() : String(v);
          }
        }
        const parentContext = propagation.extract(context.active(), headers);

        // Child of the producer's span: the message continues the trace that sent it
        const span = tracer.startSpan(
          `process ${topic}`,
          {
            kind: SpanKind.CONSUMER,
            attributes: {
              'messaging.system': 'kafka',
              'messaging.operation.type': 'process',
              'messaging.operation.name': 'process',
              'messaging.destination.name': topic,
              'messaging.kafka.destination.partition': partition,
              'messaging.kafka.message.offset': message.offset,
              // The company: the producers key by it (not personal data)
              ...(message.key && { 'messaging.kafka.message.key': message.key.toString() }),
            },
          },
          parentContext,
        );

        await context.with(trace.setSpan(parentContext, span), async () => {
          try {
            logger.debug(
              {
                'event.name': 'messaging.process.received',
                topic,
                partition,
                offset: message.offset,
                key: message.key?.toString(),
                size: value.length,
              },
              'Kafka message received',
            );

            const failed: FailedMessage = {
              topic,
              partition,
              offset: message.offset,
              key: message.key?.toString() ?? null,
              headers,
              value,
            };

            // Done or kept as a dead letter: only then is the offset committed
            await this.processWithRetry(topic, value, failed);

            await this.consumer.commitOffsets([
              { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
            ]);
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
            span.recordException(err);
            throw error;
          } finally {
            span.end();
          }
        });
      },
    });
  }

  private async processWithRetry(
    topic: string,
    value: string,
    failed: FailedMessage,
  ): Promise<void> {
    const { maxRetries, baseDelayMs } = this.retryConfig;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this.measured(topic, () => this.handleMessage(topic, value));
        return;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));

        if (!isRetryable(error)) {
          logger.error(
            {
              'event.name': 'messaging.process.dead_lettered',
              topic,
              offset: failed.offset,
              err,
              attempt,
            },
            'Non-retryable error, keeping the message as a dead letter',
          );
          await this.deadLetters.keep(failed, err, 'NON_RETRYABLE', attempt + 1);
          return;
        }

        if (attempt < maxRetries) {
          const backoff = calculateBackoff(attempt, baseDelayMs);
          logger.warn(
            {
              'event.name': 'messaging.process.retried',
              topic,
              offset: failed.offset,
              err,
              attempt: attempt + 1,
              maxRetries,
              backoff,
            },
            'Retryable error, retrying after backoff',
          );
          await sleep(backoff);
        } else {
          logger.error(
            {
              'event.name': 'messaging.process.dead_lettered',
              topic,
              offset: failed.offset,
              err,
              retriesAttempted: maxRetries,
            },
            'Max retries exhausted, keeping the message as a dead letter',
          );
          // If it can't be kept (the database is down too), this throws: no commit, it comes back
          await this.deadLetters.keep(failed, err, 'MAX_RETRIES_EXHAUSTED', attempt + 1);
        }
      }
    }
  }

  /** Records each attempt in messaging.process.duration, like faclab-core's consumer */
  private async measured(topic: string, handle: () => Promise<void>): Promise<void> {
    const attributes = {
      'messaging.system': 'kafka',
      'messaging.operation.name': 'process',
      'messaging.destination.name': topic,
      ...(this.groupId && { 'messaging.consumer.group.name': this.groupId }),
    };
    const startTime = performance.now();
    try {
      await handle();
    } catch (error) {
      messagingProcessDuration.record((performance.now() - startTime) / 1000, {
        ...attributes,
        'error.type': errorType(error),
      });
      throw error;
    }
    messagingProcessDuration.record((performance.now() - startTime) / 1000, attributes);
  }

  async stop(): Promise<void> {
    await this.consumer.disconnect();
  }
}
