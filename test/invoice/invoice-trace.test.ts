import { KafkaJS } from '@confluentinc/kafka-javascript';
import { SpanKind, SpanStatusCode, TraceFlags } from '@opentelemetry/api';
import { randomUUID } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReceiveSaleCommand } from '#/modules/invoice/app/commands/receive-sale';
import { SaleConfirmedHandler } from '#/modules/invoice/app/handlers/sale-confirmed.handler';
import { InvoiceProcessor } from '#/modules/invoice/app/services/invoice-processor';
import { InvoiceResultEvent } from '#/modules/invoice/domain/events';
import { InvoiceStatus } from '#/modules/invoice/domain/invoice';
import { invoiceTenant, toInvoiceMessage } from '#/modules/invoice/infra/messaging/invoice-message';
import { InvoiceKafkaConsumer } from '#/modules/invoice/infra/messaging/kafka-consumer';
import { KafkaProducer } from '#/modules/invoice/infra/messaging/kafka-producer';
import { SaleConfirmedMessageSchema } from '#/modules/invoice/infra/messaging/schemas';
import { InvoiceWorker } from '#/modules/invoice/infra/queue/invoice-worker';
import { DeadLetterStore } from '#/shared/infra/dead-letters';
import { captureTraceContext } from '#/shared/telemetry/trace-context';

import {
  fakeKafkaConsumer,
  InMemoryInvoiceRepository,
  invoiceSteps,
  makeCertificate,
  makeConfig,
  makeSale,
  makeSaleMessage,
  readinessStub,
  realSigner,
  simulatedSriAdapters,
  TENANT_A,
} from '../helpers';
import { captureLogs, silenceLogs } from '../logs';
import { expectChildOf, traceparentIds, traceparentOf, useSpans } from '../tracing';

/**
 * One sale, one trace (docs/architecture/OBSERVABILITY.md §5.1, §10; S7.6): the `sales.confirmed`
 * message that faclab-core sends from its `send` span goes through the real consumer, the invoice
 * queue, the real signer and SRI adapters (on canned SOAP answers) and the real producer of
 * `invoices`. Each step is a span of that trace with the parent §5.1 fixes, and the logs written on
 * the way carry it. Dropping a `contextFrom`, an `inject`/`extract` or a span fails here.
 */
const spans = useSpans();

afterEach(silenceLogs);

// faclab-core's `send sales.confirmed`, as its traceparent tells it
const CORE_SEND = {
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  spanId: '00f067aa0ba902b7',
  traceFlags: TraceFlags.SAMPLED,
  isRemote: true,
};

describe('The trace of a sale', () => {
  it('goes from faclab-core through the queue, the signature and the SRI, back to faclab-core', async () => {
    const logs = captureLogs({ level: 'debug' });
    const repo = new InMemoryInvoiceRepository();
    const readiness = readinessStub({ config: makeConfig(), certificate: makeCertificate() });

    // 1. The message arrives with the context of faclab-core's send span
    const kafka = fakeKafkaConsumer();
    const consumer = new InvoiceKafkaConsumer(
      kafka.consumer,
      ['sales.confirmed'],
      {
        'sales.confirmed': {
          handler: new SaleConfirmedHandler(new ReceiveSaleCommand(repo, captureTraceContext)),
          validator: SaleConfirmedMessageSchema,
        },
      },
      {} as DeadLetterStore,
    );
    await consumer.start();
    await kafka.deliver(
      'sales.confirmed',
      makeSaleMessage(randomUUID(), makeSale({ sale_id: 7 })),
      { traceparent: traceparentOf(CORE_SEND) },
      TENANT_A,
    );

    const received = spans.finished('process sales.confirmed');
    expect(received.kind).toBe(SpanKind.CONSUMER);
    expectChildOf(received, CORE_SEND);
    expect(received.attributes).toMatchObject({
      'messaging.system': 'kafka',
      'messaging.destination.name': 'sales.confirmed',
      'messaging.kafka.message.key': TENANT_A,
    });

    // 2. The worker takes the invoice later, in a job of the same trace
    const sent: KafkaJS.ProducerRecord[] = [];
    const producer = {
      send: async (record: KafkaJS.ProducerRecord) => void sent.push(record),
    } as unknown as KafkaJS.Producer;
    const processor = new InvoiceProcessor(
      repo,
      repo,
      invoiceSteps(repo, readiness, {
        sri: simulatedSriAdapters(),
        signer: realSigner(readiness),
      }),
      readiness,
      new KafkaProducer<InvoiceResultEvent>(producer, 'invoices', toInvoiceMessage, invoiceTenant),
    );
    const worker = new InvoiceWorker(repo, processor, {
      concurrency: 1,
      pollIntervalMs: 10,
      leaseMs: 60_000,
      errorBackoffMs: 60_000,
      holder: 'worker-1',
    });
    worker.start();
    await vi.waitFor(() => spans.finished('send invoices'), { timeout: 10_000 });
    await worker.stop();

    const job = spans.finished('process invoice');
    expect(job.kind).toBe(SpanKind.CONSUMER);
    expectChildOf(job, received);
    const invoice = await repo.getInvoiceById(String(job.attributes['faclab.invoice.id']));
    expect(invoice?.status).toBe(InvoiceStatus.AUTHORIZED);

    // 3. Signature and SRI inside the job, with what §5.2 fixes
    const sign = spans.finished('invoice.sign');
    expect(spans.descendsFrom(sign, job)).toBe(true);
    expect(sign.attributes).toEqual({ 'faclab.document.type': 'invoice' });
    expect(sign.status.code).not.toBe(SpanStatusCode.ERROR);

    const reception = spans.finished('sri.recepcion');
    const authorization = spans.finished('sri.autorizacion');
    for (const [span, method, status] of [
      [reception, 'validarComprobante', 'RECIBIDA'],
      [authorization, 'autorizacionComprobante', 'AUTORIZADO'],
    ] as const) {
      expect(span.kind).toBe(SpanKind.CLIENT);
      expect(spans.descendsFrom(span, job)).toBe(true);
      expect(span.attributes).toMatchObject({
        'rpc.system': 'soap',
        'rpc.method': method,
        'server.address': 'cel.sri.gob.ec',
        'faclab.sri.environment': 'produccion',
        'faclab.sri.status': status,
      });
    }

    // 4. The result goes back to faclab-core from the job's send span
    const send = spans.finished('send invoices');
    expect(send.kind).toBe(SpanKind.PRODUCER);
    expectChildOf(send, job);
    expect(send.attributes).toMatchObject({
      'messaging.system': 'kafka',
      'messaging.destination.name': 'invoices',
      'messaging.kafka.message.key': TENANT_A,
    });
    const headers = sent[0].messages[0].headers as Record<string, string>;
    expect(traceparentIds(headers.traceparent)).toEqual({
      traceId: CORE_SEND.traceId,
      spanId: send.spanContext().spanId,
    });

    // 5. One trace, and the logs of each step carry it with their event.name
    for (const span of [received, job, sign, reception, authorization, send]) {
      expect(span.spanContext().traceId).toBe(CORE_SEND.traceId);
    }
    const inTrace = logs().filter((line) => line.trace_id === CORE_SEND.traceId);
    const byEvent = new Map(inTrace.map((line) => [line['event.name'], line]));
    for (const [event, span] of [
      ['messaging.process.received', received],
      ['invoice.sale.received', received],
      ['invoice.result.published', job],
      ['messaging.publish.succeeded', send],
    ] as const) {
      expect(byEvent.get(event)?.span_id, event).toBe(span.spanContext().spanId);
    }
  });
});
