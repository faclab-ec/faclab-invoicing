import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { afterEach, expect, it, vi } from 'vitest';

import { ReadyIssuer } from '#/modules/company-config/app/issuer-readiness';
import { ReceiveSaleCommand } from '#/modules/invoice/app/commands/receive-sale';
import { SaleConfirmedHandler } from '#/modules/invoice/app/handlers/sale-confirmed.handler';
import { InvoiceProcessor } from '#/modules/invoice/app/services/invoice-processor';
import { InvoiceResultEvent } from '#/modules/invoice/domain/events';
import { Invoice, InvoiceStatus } from '#/modules/invoice/domain/invoice';
import { SriAuthorizationPort, SriValidationPort } from '#/modules/invoice/domain/ports';
import { InvoiceKafkaConsumer } from '#/modules/invoice/infra/messaging/kafka-consumer';
import { SaleConfirmedMessageSchema } from '#/modules/invoice/infra/messaging/schemas';
import { PgInvoiceRepository } from '#/modules/invoice/infra/persistence/pg-invoice.repository';
import { PgInvoiceQueue } from '#/modules/invoice/infra/persistence/pg-invoice-queue';
import { InvoiceWorker } from '#/modules/invoice/infra/queue/invoice-worker';
import { DeadLetterStore } from '#/shared/infra/dead-letters';

import {
  accessCodeOf,
  fakeKafkaConsumer,
  invoiceSteps,
  makeCertificate,
  makeConfig,
  makePoint,
  makeSale,
  makeSaleMessage,
  readinessStub,
  RUC_B,
  simulatedSri,
  TENANT_A,
  TENANT_B,
} from '../helpers';
import { anotherPool, describePostgres, usePostgres } from './support';

// The certificate's id is the signature id of the invoice, a uuid column
const CERTIFICATE_ID = randomUUID();
const READY: ReadyIssuer = {
  config: makeConfig({ signingCertId: CERTIFICATE_ID }),
  certificate: makeCertificate({ id: CERTIFICATE_ID }),
};
const RECEIVED_AT = new Date('2026-10-20T10:00:00Z');
// The worker's tests wait for real work: more than vitest's 5 s
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describePostgres('Invoice queue on PostgreSQL', () => {
  const pool = usePostgres();
  const extraPools: Pool[] = [];
  const workers: InvoiceWorker[] = [];
  // Run before stopping the workers, which wait for the invoices in progress
  const cleanups: (() => void)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    await Promise.all(workers.splice(0).map((worker) => worker.stop()));
    await Promise.all(extraPools.splice(0).map((extra) => extra.end()));
  });

  /** A second process of the service: a pool of its own on the same database */
  const otherProcess = () => {
    const extra = anotherPool(pool());
    extraPools.push(extra);
    return extra;
  };

  async function received(count: number, point = makePoint(), firstSale = 1): Promise<string[]> {
    const repo = new PgInvoiceRepository(pool());
    const ids: string[] = [];
    for (let n = 0; n < count; n++) {
      const sale = makeSale({ sale_id: firstSale + n });
      const invoice = Invoice.receive(randomUUID(), point, sale, RECEIVED_AT);
      await repo.createInvoice(invoice);
      ids.push(invoice.id);
    }
    return ids;
  }

  /** A worker of a process (its pool), against `sri`, publishing into `published` */
  function startWorker(
    workerPool: Pool,
    holder: string,
    {
      sri = {},
      published = [],
      concurrency = 2,
    }: {
      sri?: Partial<SriValidationPort & SriAuthorizationPort>;
      published?: InvoiceResultEvent[];
      concurrency?: number;
    } = {},
  ) {
    const repo = new PgInvoiceRepository(workerPool);
    const queue = new PgInvoiceQueue(workerPool);
    const readiness = readinessStub(READY);
    const processor = new InvoiceProcessor(
      repo,
      queue,
      invoiceSteps(repo, readiness, { sri }),
      readiness,
      { sendMessage: async (event) => void published.push(event) },
    );
    const run = vi.spyOn(processor, 'run');
    const worker = new InvoiceWorker(queue, processor, {
      concurrency,
      pollIntervalMs: 20,
      leaseMs: 60_000,
      errorBackoffMs: 60_000,
      holder,
    });
    workers.push(worker);
    worker.start();
    return { worker, run };
  }

  const statusOf = async (id: string) =>
    (await new PgInvoiceRepository(pool()).getInvoiceById(id))!.status;

  it('gives each due invoice to a single holder, also when two take at the same time', async () => {
    const ids = await received(20);
    const first = new PgInvoiceQueue(pool());
    const second = new PgInvoiceQueue(otherProcess());

    const [ofFirst, ofSecond] = await Promise.all([
      first.claimDue('a:1', 60_000, 15),
      second.claimDue('b:1', 60_000, 15),
    ]);

    const taken = [...ofFirst, ...ofSecond].map((job) => job.id);
    expect(taken.sort()).toEqual([...ids].sort());
    expect(await first.claimDue('c:1', 60_000, 15)).toEqual([]);
    expect(await first.claim(ids[0], 'c:1', 60_000)).toBe(false);
  });

  it('gives an invoice out again only once its lease runs out', async () => {
    let now = new Date(RECEIVED_AT.getTime() + 60_000);
    const queue = new PgInvoiceQueue(pool(), () => now);
    const [id] = await received(1);

    const [job] = await queue.claimDue('a:1', 1_000, 5);
    expect(job.id).toBe(id);
    expect(await queue.claimDue('b:1', 1_000, 5)).toEqual([]);

    now = new Date(now.getTime() + 1_001);
    expect((await queue.claimDue('b:1', 1_000, 5)).map((j) => j.id)).toEqual([id]);
    // The first holder lost it: it can neither extend nor let go of b's lease
    expect(await queue.renew(id, 'a:1', 1_000)).toBe(false);
    await queue.release(id, 'a:1');
    expect(await queue.claim(id, 'c:1', 1_000)).toBe(false);

    expect(await queue.renew(id, 'b:1', 1_000)).toBe(true);
    await queue.release(id, 'b:1');
    expect(await queue.claim(id, 'c:1', 1_000)).toBe(true);
    expect(await queue.claim('not-a-uuid', 'c:1', 1_000)).toBe(false);
  });

  it("doesn't change the invoice's version: the step in progress still saves", async () => {
    const repo = new PgInvoiceRepository(pool());
    const queue = new PgInvoiceQueue(pool());
    const [id] = await received(1);
    const invoice = (await repo.getInvoiceById(id))!;

    await queue.claimDue('a:1', 60_000, 1);
    await queue.postpone(id, new Date());
    await queue.requeue([id], new Date(0));
    await queue.release(id, 'a:1');
    invoice.recordIssue({ code: 'SRI_UNAVAILABLE', message: 'x', at: new Date() });

    await expect(repo.updateInvoice(invoice)).resolves.toBeDefined();
  });

  it('finds the invoices that wait and puts them back in the queue', async () => {
    const now = new Date(RECEIVED_AT.getTime() + 60_000);
    const repo = new PgInvoiceRepository(pool());
    const queue = new PgInvoiceQueue(pool(), () => now);
    const [blocked, due, finished] = await received(3);
    const [ofB] = await received(1, makePoint({ tenantId: TENANT_B, issuerRuc: RUC_B }), 50);
    for (const id of [blocked, ofB]) {
      const invoice = (await repo.getInvoiceById(id))!;
      invoice.recordIssue({ code: 'CONFIG_MISSING', message: 'x', at: now });
      await repo.updateInvoice(invoice);
    }
    const final = (await repo.getInvoiceById(finished))!;
    final.reject(['NO AUTORIZADO']);
    final.markResultPublished(now);
    await repo.updateInvoice(final);

    expect((await queue.findWaiting()).map((w) => w.id).sort()).toEqual([blocked, ofB].sort());
    expect(await queue.findWaiting(TENANT_A)).toEqual([
      {
        id: blocked,
        tenantId: TENANT_A,
        issuerRuc: makePoint().issuerRuc,
        issueCode: 'CONFIG_MISSING',
        nextAttemptAt: null,
      },
    ]);

    // Final or already due: left as they are
    expect(await queue.requeue([blocked, due, finished], now)).toBe(1);
    expect((await queue.claimDue('a:1', 60_000, 10)).map((j) => j.id).sort()).toEqual(
      [blocked, due].sort(),
    );
  });

  it('keeps receiving new sales while the SRI takes 30 s to answer', async () => {
    // The SRI takes 30 s to receive an invoice; the test lets it answer at the end instead
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    let slowTimer: ReturnType<typeof setTimeout> | undefined;
    const validateXml = vi.fn<Parameters<SriValidationPort['validateXml']>>(async (...args) => {
      await Promise.race([
        answered,
        new Promise((resolve) => {
          slowTimer = setTimeout(resolve, 30_000);
        }),
      ]);
      return simulatedSri.validateXml(...args);
    });
    // Let it answer however the test ends: stopping the worker waits for it
    cleanups.push(() => {
      answer();
      clearTimeout(slowTimer);
    });
    await received(1);
    // Its only slot busy with the SRI
    startWorker(pool(), 'worker-1', { sri: { validateXml }, concurrency: 1 });
    await vi.waitFor(() => expect(validateXml).toHaveBeenCalled(), { timeout: 10_000 });

    const kafka = fakeKafkaConsumer();
    const repo = new PgInvoiceRepository(otherProcess());
    const consumer = new InvoiceKafkaConsumer(
      kafka.consumer,
      ['sales.confirmed'],
      {
        'sales.confirmed': {
          handler: new SaleConfirmedHandler(new ReceiveSaleCommand(repo)),
          validator: SaleConfirmedMessageSchema,
        },
      },
      {} as DeadLetterStore,
    );
    await consumer.start();

    const started = performance.now();
    for (let n = 0; n < 20; n++) {
      await kafka.deliver(
        'sales.confirmed',
        makeSaleMessage(randomUUID(), makeSale({ sale_id: 100 + n })),
      );
    }
    const elapsed = performance.now() - started;

    // Every sale stored and its offset committed while the SRI still holds the first invoice
    expect(kafka.committed).toHaveLength(20);
    expect(elapsed).toBeLessThan(5_000);
    expect(validateXml).toHaveBeenCalledTimes(1);
    const { rows } = await pool().query<{ pending: string }>(
      "SELECT count(*) AS pending FROM invoices WHERE status = 'pending' AND sale_id::int >= 100",
    );
    expect(Number(rows[0].pending)).toBe(20);
  }, 30_000);

  it('never sends the same invoice twice with two workers running in parallel', async () => {
    const ids = await received(10);
    const sent = new Map<string, number>();
    const sri: Partial<SriValidationPort> = {
      validateXml: async (xml, environment) => {
        const code = accessCodeOf(xml);
        sent.set(code, (sent.get(code) ?? 0) + 1);
        // An SRI whose answers take a while, each a different time
        await sleep(Math.random() * 40);
        return simulatedSri.validateXml(xml, environment);
      },
    };
    const published: InvoiceResultEvent[] = [];

    // Two processes, two slots each
    const first = startWorker(pool(), 'process-1', { sri, published });
    const second = startWorker(otherProcess(), 'process-2', { sri, published });
    await vi.waitFor(() => expect(published).toHaveLength(10), { timeout: 20_000 });

    expect(await Promise.all(ids.map(statusOf))).toEqual(Array(10).fill(InvoiceStatus.AUTHORIZED));
    expect(sent.size).toBe(10);
    expect([...sent.values()].every((times) => times === 1)).toBe(true);
    expect(new Set(published.map((event) => event.invoiceId))).toEqual(new Set(ids));
    // Both took part
    expect(first.run).toHaveBeenCalled();
    expect(second.run).toHaveBeenCalled();
    const { rows } = await pool().query<{ sequence: string }>(
      'SELECT sequence FROM invoices ORDER BY sequence',
    );
    expect(rows.map((row) => Number(row.sequence))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  }, 30_000);

  it('takes up the invoices left pending after the worker restarts', async () => {
    const [left, ...waiting] = await received(3);
    // A worker took the first invoice and died while it ran: its lease is still there
    const died = new PgInvoiceQueue(pool());
    expect(await died.claim(left, 'dead-process:1', 2_000)).toBe(true);

    // The worker starts again (a new process)
    startWorker(otherProcess(), 'restarted');

    // The rest at once; the one it left once its lease runs out
    await vi.waitFor(
      async () =>
        expect(await Promise.all(waiting.map(statusOf))).toEqual([
          InvoiceStatus.AUTHORIZED,
          InvoiceStatus.AUTHORIZED,
        ]),
      { timeout: 10_000 },
    );
    expect(await statusOf(left)).toBe(InvoiceStatus.PENDING);
    await vi.waitFor(async () => expect(await statusOf(left)).toBe(InvoiceStatus.AUTHORIZED), {
      timeout: 10_000,
    });
  }, 30_000);
});
