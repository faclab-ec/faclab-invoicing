import { KafkaJS } from '@confluentinc/kafka-javascript';
import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

import { BadRequestError, ValidationError } from '../errors/app-error';
import { NonRetryableError } from '../errors/non-retryable.error';
import { logger } from '../logger';
import { kafkaMessageCount, kafkaMessageDuration, kafkaRetryCount } from '../telemetry/metrics';
import { DeadLetterStore, FailedMessage } from './dead-letters';

// Header with the company (faclab-core tenant) of a message, the same name faclab-core uses
export const TENANT_HEADER = 'faclab-tenant-id';

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
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

export abstract class BaseKafkaConsumer {
  private retryConfig: RetryConfig;

  constructor(
    private consumer: KafkaJS.Consumer,
    private topics: string[],
    private deadLetters: DeadLetterStore,
    retryConfig?: Partial<RetryConfig>,
  ) {
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
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
            },
          },
          parentContext,
        );

        const startTime = performance.now();

        await context.with(trace.setSpan(parentContext, span), async () => {
          try {
            logger.debug(
              {
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

            kafkaMessageCount.add(1, { topic, status: 'success' });
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
            span.recordException(err);
            kafkaMessageCount.add(1, { topic, status: 'error' });
            throw error;
          } finally {
            kafkaMessageDuration.record(performance.now() - startTime, { topic });
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
        await this.handleMessage(topic, value);
        return;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));

        if (!isRetryable(error)) {
          logger.error(
            { topic, offset: failed.offset, err, attempt },
            'Non-retryable error, keeping the message as a dead letter',
          );
          await this.deadLetters.keep(failed, err, 'NON_RETRYABLE', attempt + 1);
          return;
        }

        if (attempt < maxRetries) {
          kafkaRetryCount.add(1, { topic, attempt: attempt + 1 });
          const backoff = calculateBackoff(attempt, baseDelayMs);
          logger.warn(
            { topic, offset: failed.offset, err, attempt: attempt + 1, maxRetries, backoff },
            'Retryable error, retrying after backoff',
          );
          await sleep(backoff);
        } else {
          logger.error(
            { topic, offset: failed.offset, err, retriesAttempted: maxRetries },
            'Max retries exhausted, keeping the message as a dead letter',
          );
          // If it can't be kept (the database is down too), this throws: no commit, it comes back
          await this.deadLetters.keep(failed, err, 'MAX_RETRIES_EXHAUSTED', attempt + 1);
        }
      }
    }
  }

  async stop(): Promise<void> {
    await this.consumer.disconnect();
  }
}
