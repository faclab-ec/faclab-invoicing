import { KafkaJS } from '@confluentinc/kafka-javascript';
import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

import { TENANT_HEADER } from '#/shared/infra/kafka';
import { logger } from '#/shared/logger';
import { errorType } from '#/shared/telemetry/attributes';
import { messagingSentMessages } from '#/shared/telemetry/metrics';

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
    const metricAttributes = {
      'messaging.system': 'kafka',
      'messaging.operation.name': 'send',
      'messaging.destination.name': this.topic,
    };
    // The company keys the message: its documents keep their order in one partition
    const tenantId = this.tenantOf?.(message);
    const span = tracer.startSpan(`send ${this.topic}`, {
      kind: SpanKind.PRODUCER,
      attributes: {
        ...metricAttributes,
        'messaging.operation.type': 'send',
        ...(tenantId && { 'messaging.kafka.message.key': tenantId }),
      },
    });

    // The consumer continues from this span, not from whatever was active before it, and what is
    // logged while sending carries it
    const active = trace.setSpan(context.active(), span);
    const headers: Record<string, string> = {};
    propagation.inject(active, headers);
    if (tenantId) headers[TENANT_HEADER] = tenantId;

    await context.with(active, async () => {
      try {
        await this.producer.send({
          topic: this.topic,
          messages: [{ key: tenantId, value: JSON.stringify(this.toMessage(message)), headers }],
        });
        messagingSentMessages.add(1, metricAttributes);
        logger.debug(
          { 'event.name': 'messaging.publish.succeeded', topic: this.topic },
          'Message sent',
        );
      } catch (error) {
        messagingSentMessages.add(1, { ...metricAttributes, 'error.type': errorType(error) });
        const err = error instanceof Error ? error : new Error(String(error));
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        span.recordException(err);
        throw error;
      } finally {
        span.end();
      }
    });
  }
}
