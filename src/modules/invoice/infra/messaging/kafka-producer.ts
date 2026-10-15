import { KafkaJS } from '@confluentinc/kafka-javascript';
import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

import { logger } from '#/shared/logger';

import { MessageProducer } from '../../domain/ports';

const tracer = trace.getTracer('faclab-invoicing.kafka');

export class KafkaProducer<T> implements MessageProducer<T> {
  constructor(
    private producer: KafkaJS.Producer,
    private topic: string,
  ) {}

  async connect(): Promise<void> {
    await this.producer.connect();
  }

  async disconnect(): Promise<void> {
    await this.producer.disconnect();
  }

  async sendMessage(message: T): Promise<void> {
    const span = tracer.startSpan(`send ${this.topic}`, {
      kind: SpanKind.PRODUCER,
      attributes: {
        'messaging.system': 'kafka',
        'messaging.operation.type': 'send',
        'messaging.operation.name': 'send',
        'messaging.destination.name': this.topic,
      },
    });

    // The consumer continues from this span, not from whatever was active before it
    const headers: Record<string, string> = {};
    propagation.inject(trace.setSpan(context.active(), span), headers);

    try {
      await this.producer.send({
        topic: this.topic,
        messages: [{ value: JSON.stringify(message), headers }],
      });
      logger.debug({ topic: this.topic }, 'Message sent');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      throw error;
    } finally {
      span.end();
    }
  }
}
