import { randomUUID } from 'crypto';
import { afterEach, expect, it, vi } from 'vitest';

import { ReadyIssuer } from '#/modules/company-config/app/issuer-readiness';
import { invoiceIdForEvent, ReceiveSaleCommand } from '#/modules/invoice/app/commands/receive-sale';
import { SaleConfirmedHandler } from '#/modules/invoice/app/handlers/sale-confirmed.handler';
import { InvoiceProcessor } from '#/modules/invoice/app/services/invoice-processor';
import { InvoiceResultEvent } from '#/modules/invoice/domain/events';
import { Invoice, InvoiceStatus } from '#/modules/invoice/domain/invoice';
import {
  dispatchMessage,
  InvoiceKafkaConsumer,
  MessageProcessors,
} from '#/modules/invoice/infra/messaging/kafka-consumer';
import { SaleConfirmedMessageSchema } from '#/modules/invoice/infra/messaging/schemas';
import { PgInvoiceRepository } from '#/modules/invoice/infra/persistence/pg-invoice.repository';
import { PgInvoiceQueue } from '#/modules/invoice/infra/persistence/pg-invoice-queue';
import { InvoiceWorker } from '#/modules/invoice/infra/queue/invoice-worker';
import { DeadLetterReprocessor, PgDeadLetterStore } from '#/shared/infra/dead-letters';

import {
  fakeKafkaConsumer,
  invoiceSteps,
  makeCertificate,
  makeConfig,
  makeSale,
  makeSaleMessage,
  readinessStub,
  TENANT_A,
} from '../helpers';
import { describePostgres, usePostgres } from './support';

const CERTIFICATE_ID = randomUUID();
const READY: ReadyIssuer = {
  config: makeConfig({ signingCertId: CERTIFICATE_ID }),
  certificate: makeCertificate({ id: CERTIFICATE_ID }),
};

/** The invoices table answers nothing while `down` (a database outage the retries outlast) */
class FlakyInvoiceRepository extends PgInvoiceRepository {
  down = false;

  override async createInvoice(invoice: Invoice): Promise<boolean> {
    if (this.down) throw new Error('Connection terminated unexpectedly');
    return super.createInvoice(invoice);
  }
}

describePostgres('Dead letters on PostgreSQL', () => {
  const pool = usePostgres();
  const workers: InvoiceWorker[] = [];

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  });

  function processors(repo: PgInvoiceRepository): MessageProcessors {
    return {
      'sales.confirmed': {
        handler: new SaleConfirmedHandler(new ReceiveSaleCommand(repo)),
        validator: SaleConfirmedMessageSchema,
      },
    };
  }

  it('reprocesses a sale left as a dead letter and the worker invoices it', async () => {
    const repo = new FlakyInvoiceRepository(pool());
    const store = new PgDeadLetterStore(pool(), 'faclab-invoicing');
    const kafka = fakeKafkaConsumer();
    const consumer = new InvoiceKafkaConsumer(
      kafka.consumer,
      ['sales.confirmed'],
      processors(repo),
      store,
      { maxRetries: 1, baseDelayMs: 1 },
    );
    await consumer.start();
    const eventId = randomUUID();
    const message = makeSaleMessage(eventId, makeSale({ sale_id: 7 }));

    // The database fails longer than the retries: the sale is kept, the partition goes on
    repo.down = true;
    await kafka.deliver('sales.confirmed', message, { 'faclab-tenant-id': TENANT_A });
    repo.down = false;

    expect(kafka.committed).toEqual(['1']);
    const [letter] = await store.pending(10);
    expect(letter).toMatchObject({
      topic: 'sales.confirmed',
      tenantId: TENANT_A,
      errorType: 'MAX_RETRIES_EXHAUSTED',
      error: 'Connection terminated unexpectedly',
      attempts: 2,
      status: 'pending',
    });
    // Delivered again after a failed commit, it is kept once
    await store.keep(letter, new Error('again'), 'MAX_RETRIES_EXHAUSTED', 2);
    expect(await store.pending(10)).toHaveLength(1);
    expect(await repo.getInvoiceById(invoiceIdForEvent(eventId))).toBeNull();

    const reprocessor = new DeadLetterReprocessor(store, (topic, value) =>
      dispatchMessage(processors(repo), topic, value),
    );
    expect(await reprocessor.reprocess(letter.id, 'ana')).toEqual({
      id: letter.id,
      reprocessed: true,
    });

    const reprocessed = await store.get(letter.id);
    expect(reprocessed).toMatchObject({ status: 'reprocessed', reprocessedBy: 'ana' });
    expect(await store.pending(10)).toEqual([]);
    // The worker takes the invoice it left and the SRI authorizes it
    const published: InvoiceResultEvent[] = [];
    const queue = new PgInvoiceQueue(pool());
    const readiness = readinessStub(READY);
    const worker = new InvoiceWorker(
      queue,
      new InvoiceProcessor(repo, queue, invoiceSteps(repo, readiness), readiness, {
        sendMessage: async (event) => void published.push(event),
      }),
      { concurrency: 1, pollIntervalMs: 20, leaseMs: 60_000, errorBackoffMs: 60_000, holder: 'w' },
    );
    workers.push(worker);
    worker.start();

    await vi.waitFor(() => expect(published).toHaveLength(1), { timeout: 10_000 });
    expect(published[0]).toMatchObject({ type: 'InvoiceAuthorized', saleId: '7' });
    const invoice = await repo.getInvoiceById(invoiceIdForEvent(eventId));
    expect(invoice?.status).toBe(InvoiceStatus.AUTHORIZED);
    // Reprocessing it again does nothing
    expect((await reprocessor.reprocess(letter.id, 'luis')).reprocessed).toBe(false);
  }, 20_000);

  it('keeps a message whose company is not a uuid without its tenant', async () => {
    const store = new PgDeadLetterStore(pool(), 'faclab-invoicing');

    await store.keep(
      {
        topic: 'sales.confirmed',
        partition: 2,
        offset: '15',
        key: null,
        headers: { 'faclab-tenant-id': 'not-a-company' },
        value: '{',
      },
      new Error('Invalid JSON'),
      'NON_RETRYABLE',
      1,
    );

    const [letter] = await store.pending(10);
    expect(letter).toMatchObject({
      partition: 2,
      offset: '15',
      tenantId: null,
      headers: { 'faclab-tenant-id': 'not-a-company' },
    });
  });
});
