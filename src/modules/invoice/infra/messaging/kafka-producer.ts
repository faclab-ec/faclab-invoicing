import { KafkaJS } from '@confluentinc/kafka-javascript';
import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

import { TENANT_HEADER } from '#/shared/infra/kafka';
import { logger } from '#/shared/logger';

import { MessageProducer } from '../../domain/ports';

const tracer = trace.getTracer('faclab-invoicing.kafka');

export class KafkaProducer<T> implements MessageProducer<T> {
  constructor(
    private producer: KafkaJS.Producer,
    private topic: string,
    // Shapes the message as the topic's contract defines it
    private toMessage: (message: T) => unknown = (message) => message,
    // The company of the message: its key, so a company's messages keep their order, and its
    // `faclab-tenant-id` header, which faclab-core opens the tenant context with
    private tenantOf?: (message: T) => string,
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
    const tenantId = this.tenantOf?.(message);
    if (tenantId) headers[TENANT_HEADER] = tenantId;

    try {
      await this.producer.send({
        topic: this.topic,
        messages: [{ key: tenantId, value: JSON.stringify(this.toMessage(message)), headers }],
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
