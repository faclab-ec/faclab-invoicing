import { KafkaJS } from '@confluentinc/kafka-javascript';
import { SpanKind, trace } from '@opentelemetry/api';
import { node, tracing } from '@opentelemetry/sdk-node';
import { randomUUID } from 'crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReceiveSaleCommand } from '#/modules/invoice/app/commands/receive-sale';
import { InvoiceProcessor } from '#/modules/invoice/app/services/invoice-processor';
import { InvoiceResultEvent } from '#/modules/invoice/domain/events';
import { invoiceTenant, toInvoiceMessage } from '#/modules/invoice/infra/messaging/invoice-message';
import { KafkaProducer } from '#/modules/invoice/infra/messaging/kafka-producer';
import { InvoiceWorker } from '#/modules/invoice/infra/queue/invoice-worker';
import { DlqProducer } from '#/shared/infra/dlq-producer';
import { BaseKafkaConsumer } from '#/shared/infra/kafka';
import { captureTraceContext } from '#/shared/telemetry/trace-context';

import {
  InMemoryInvoiceRepository,
  invoiceSteps,
  makeCertificate,
  makeConfig,
  makeReceivedSale,
  readinessStub,
} from '../helpers';

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

describe('InvoiceWorker', () => {
  it('runs an invoice in the trace of the message that brought its sale', async () => {
    const repo = new InMemoryInvoiceRepository();
    const receive = new ReceiveSaleCommand(repo, captureTraceContext);
    // The sale arrives while the consumer processes its message
    const consumer = await trace
      .getTracer('test')
      .startActiveSpan('process sales.confirmed', async (span) => {
        await receive.execute(makeReceivedSale(randomUUID()));
        span.end();
        return span;
      });

    const readiness = readinessStub({ config: makeConfig(), certificate: makeCertificate() });
    const kafka = { send: async () => undefined } as unknown as KafkaJS.Producer;
    const processor = new InvoiceProcessor(
      repo,
      repo,
      invoiceSteps(repo, readiness),
      readiness,
      new KafkaProducer<InvoiceResultEvent>(kafka, 'invoices', toInvoiceMessage, invoiceTenant),
    );
    const worker = new InvoiceWorker(repo, processor, {
      concurrency: 1,
      pollIntervalMs: 10,
      leaseMs: 60_000,
      errorBackoffMs: 60_000,
      holder: 'worker-1',
    });
    worker.start();
    await vi.waitFor(() => finished('send invoices'));
    await worker.stop();

    // A later, separate job of the same trace, child of the consumer
    const job = finished('process invoice');
    expect(job.kind).toBe(SpanKind.CONSUMER);
    expect(job.spanContext().traceId).toBe(consumer.spanContext().traceId);
    expect(job.parentSpanContext?.spanId).toBe(consumer.spanContext().spanId);
    // And faclab-core continues from the job
    const send = finished('send invoices');
    expect(send.spanContext().traceId).toBe(consumer.spanContext().traceId);
    expect(send.parentSpanContext?.spanId).toBe(job.spanContext().spanId);
  });
});
