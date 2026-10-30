import { KafkaJS } from '@confluentinc/kafka-javascript';
import { ZodSchema } from 'zod';

import { NonRetryableError } from '#/shared/errors/non-retryable.error';
import { DeadLetterStore } from '#/shared/infra/dead-letters';
import { BaseKafkaConsumer, RetryConfig } from '#/shared/infra/kafka';
import { logger } from '#/shared/logger';

interface MessageProcessor {
  handle(message: unknown): Promise<void>;
}

export type MessageProcessors = Record<string, { handler: MessageProcessor; validator: ZodSchema }>;

/**
 * What a message of a topic does: parsed, validated with its topic's schema and handed to its
 * handler. The consumer runs it for each message and the reprocessing of dead letters for each one
 * it takes up again
 */
export async function dispatchMessage(
  processors: MessageProcessors,
  topic: string,
  message: string,
): Promise<void> {
  const processor = processors[topic];
  if (!processor) {
    throw new NonRetryableError(`No processor defined for topic: ${topic}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    throw new NonRetryableError(`Invalid JSON in message from topic: ${topic}`);
  }

  const result = processor.validator.safeParse(parsed);

  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new NonRetryableError(`Invalid message schema on topic ${topic}: ${issues}`);
  }

  logger.debug({ topic }, 'Message validated, dispatching to handler');
  await processor.handler.handle(result.data);
}

export class InvoiceKafkaConsumer extends BaseKafkaConsumer {
  constructor(
    consumer: KafkaJS.Consumer,
    topics: string[],
    private processors: MessageProcessors,
    deadLetters: DeadLetterStore,
    retryConfig?: Partial<RetryConfig>,
  ) {
    super(consumer, topics, deadLetters, retryConfig);
  }

  protected async handleMessage(topic: string, message: string): Promise<void> {
    await dispatchMessage(this.processors, topic, message);
  }
}
