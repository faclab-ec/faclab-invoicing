import { KafkaJS } from '@confluentinc/kafka-javascript';
import {
  context as otelContext,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';

import { logger } from '../logger';
import { dlqMessageCount } from '../telemetry/metrics';

const tracer = trace.getTracer('faclab-invoicing.kafka');

interface DlqEnvelope {
  originalTopic: string;
  originalPartition: number;
  originalOffset: string;
  originalKey: string | null;
  originalValue: string;
  originalTimestamp: string | null;
  errorMessage: string;
  errorType: 'NON_RETRYABLE' | 'MAX_RETRIES_EXHAUSTED';
  retriesAttempted: number;
  consumerGroupId: string;
  failedAt: string;
}

export interface DlqMessageContext {
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
  value: string;
  timestamp: string | null;
}

export class DlqProducer {
  constructor(
    private producer: KafkaJS.Producer,
    private dlqTopic: string,
    private consumerGroupId: string,
  ) {}

  async send(
    msgContext: DlqMessageContext,
    error: Error,
    errorType: 'NON_RETRYABLE' | 'MAX_RETRIES_EXHAUSTED',
    retriesAttempted: number,
  ): Promise<void> {
    const span = tracer.startSpan(`send ${this.dlqTopic}`, {
      kind: SpanKind.PRODUCER,
      attributes: {
        'messaging.system': 'kafka',
        'messaging.operation.type': 'send',
        'messaging.operation.name': 'send',
        'messaging.destination.name': this.dlqTopic,
        'messaging.kafka.dlq.original_topic': msgContext.topic,
        'messaging.kafka.dlq.error_type': errorType,
      },
    });

    try {
      const envelope: DlqEnvelope = {
        originalTopic: msgContext.topic,
        originalPartition: msgContext.partition,
        originalOffset: msgContext.offset,
        originalKey: msgContext.key,
        originalValue: msgContext.value,
        originalTimestamp: msgContext.timestamp,
        errorMessage: error.message,
        errorType,
        retriesAttempted,
        consumerGroupId: this.consumerGroupId,
        failedAt: new Date().toISOString(),
      };

      const key = `${msgContext.topic}:${msgContext.partition}:${msgContext.offset}`;
      const headers: Record<string, string> = {};
      propagation.inject(trace.setSpan(otelContext.active(), span), headers);

      await this.producer.send({
        topic: this.dlqTopic,
        messages: [{ key, value: JSON.stringify(envelope), headers }],
      });

      dlqMessageCount.add(1, { original_topic: msgContext.topic, error_type: errorType });

      logger.warn(
        {
          dlqTopic: this.dlqTopic,
          originalTopic: msgContext.topic,
          originalOffset: msgContext.offset,
          errorType,
          errorMessage: error.message,
        },
        'Message sent to DLQ',
      );
    } catch (sendError) {
      const err = sendError instanceof Error ? sendError : new Error(String(sendError));
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      throw sendError;
    } finally {
      span.end();
    }
  }
}
