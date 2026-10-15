import { KafkaJS } from '@confluentinc/kafka-javascript';
import { SpanKind, trace } from '@opentelemetry/api';
import { node, tracing } from '@opentelemetry/sdk-node';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { KafkaProducer } from '#/modules/invoice/infra/messaging/kafka-producer';
import { DlqProducer } from '#/shared/infra/dlq-producer';
import { BaseKafkaConsumer } from '#/shared/infra/kafka';

const exporter = new tracing.InMemorySpanExporter();

beforeAll(() => {
  // Global provider with W3C propagation and async context, as sdk-node sets up in the service
  new node.NodeTracerProvider({
    spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
  }).register();
});

beforeEach(() => exporter.reset());

const finished = (name: string) => {
  const span = exporter.getFinishedSpans().find((s) => s.name === name);
  if (!span) throw new Error(`No span named ${name}`);
  return span;
};

describe('KafkaProducer', () => {
  it('sends the context of its own span, so the consumer continues from it', async () => {
    const sent: KafkaJS.ProducerRecord[] = [];
    const kafka = {
      send: async (record: KafkaJS.ProducerRecord) => {
        sent.push(record);
      },
    } as unknown as KafkaJS.Producer;
    const producer = new KafkaProducer<{ id: string }>(kafka, 'invoices');

    const parent = await trace
      .getTracer('test')
      .startActiveSpan('process sales.confirmed', async (span) => {
        await producer.sendMessage({ id: '1' });
        span.end();
        return span;
      });

    const send = finished('send invoices');
    expect(send.kind).toBe(SpanKind.PRODUCER);
    expect(send.spanContext().traceId).toBe(parent.spanContext().traceId);
    expect(send.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    const headers = sent[0].messages[0].headers as Record<string, string>;
    const [, traceId, spanId] = headers.traceparent.split('-');
    expect(traceId).toBe(send.spanContext().traceId);
    expect(spanId).toBe(send.spanContext().spanId);
  });
});

class RecordingConsumer extends BaseKafkaConsumer {
  handled: string[] = [];

  protected async handleMessage(_topic: string, message: string): Promise<void> {
    this.handled.push(message);
  }
}

describe('BaseKafkaConsumer', () => {
  it('processes a message as a child of the span that sent it', async () => {
    let eachMessage: KafkaJS.EachMessageHandler | undefined;
    const kafka = {
      connect: async () => {},
      subscribe: async () => {},
      run: async (config: KafkaJS.ConsumerRunConfig) => {
        eachMessage = config.eachMessage;
      },
      commitOffsets: async () => {},
    } as unknown as KafkaJS.Consumer;
    const consumer = new RecordingConsumer(kafka, ['sales.confirmed'], {} as DlqProducer);
    await consumer.start();

    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const sentFrom = '00f067aa0ba902b7';
    await eachMessage!({
      topic: 'sales.confirmed',
      partition: 0,
      message: {
        key: null,
        value: Buffer.from('{"event_id":"e-1"}'),
        headers: { traceparent: Buffer.from(`00-${traceId}-${sentFrom}-01`) },
        offset: '5',
        timestamp: '0',
      },
    } as unknown as KafkaJS.EachMessagePayload);

    const process = finished('process sales.confirmed');
    expect(process.kind).toBe(SpanKind.CONSUMER);
    expect(process.spanContext().traceId).toBe(traceId);
    expect(process.parentSpanContext?.spanId).toBe(sentFrom);
    expect(consumer.handled).toEqual(['{"event_id":"e-1"}']);
  });
});
