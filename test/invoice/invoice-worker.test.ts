import { randomUUID } from 'crypto';
import { describe, expect, it, vi } from 'vitest';

import { ReadyIssuer } from '#/modules/company-config/app/issuer-readiness';
import { ReceiveSaleCommand } from '#/modules/invoice/app/commands/receive-sale';
import { SaleConfirmedHandler } from '#/modules/invoice/app/handlers/sale-confirmed.handler';
import { InvoiceProcessor } from '#/modules/invoice/app/services/invoice-processor';
import { InvoiceResultEvent } from '#/modules/invoice/domain/events';
import { Invoice, InvoiceStatus } from '#/modules/invoice/domain/invoice';
import { SriValidationPort } from '#/modules/invoice/domain/ports';
import { InvoiceKafkaConsumer } from '#/modules/invoice/infra/messaging/kafka-consumer';
import { SaleConfirmedMessageSchema } from '#/modules/invoice/infra/messaging/schemas';
import { InvoiceWorker } from '#/modules/invoice/infra/queue/invoice-worker';
import { DeadLetterStore } from '#/shared/infra/dead-letters';

import {
  fakeKafkaConsumer,
  InMemoryInvoiceRepository,
  invoiceSteps,
  makeCertificate,
  makeConfig,
  makePoint,
  makeSale,
  makeSaleMessage,
  readinessStub,
  simulatedSri,
} from '../helpers';

const READY: ReadyIssuer = { config: makeConfig(), certificate: makeCertificate() };
const OPTIONS = {
  concurrency: 2,
  pollIntervalMs: 10,
  leaseMs: 60_000,
  errorBackoffMs: 60_000,
  holder: 'worker-1',
};

/** An SRI reception that doesn't answer until the test lets it */
function hangingReception() {
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const validateXml = vi.fn<Parameters<SriValidationPort['validateXml']>>(async (...args) => {
    await answered;
    return simulatedSri.validateXml(...args);
  });
  return { validateXml, answer };
}

function workerFor(
  repo: InMemoryInvoiceRepository,
  sri: Parameters<typeof invoiceSteps>[2] = {},
  heartbeat = { beat: vi.fn() },
) {
  const published: InvoiceResultEvent[] = [];
  const readiness = readinessStub(READY);
  const processor = new InvoiceProcessor(
    repo,
    repo,
    invoiceSteps(repo, readiness, sri),
    readiness,
    { sendMessage: async (event) => void published.push(event) },
  );
  return { worker: new InvoiceWorker(repo, processor, OPTIONS, heartbeat), published, heartbeat };
}

async function received(repo: InMemoryInvoiceRepository, count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, () => randomUUID());
  for (const [n, id] of ids.entries()) {
    await repo.createInvoice(Invoice.receive(id, makePoint(), makeSale({ sale_id: n + 1 })));
  }
  return ids;
}

const statuses = async (repo: InMemoryInvoiceRepository, ids: string[]) =>
  Promise.all(ids.map(async (id) => (await repo.getInvoiceById(id))!.status));

describe('InvoiceWorker', () => {
  it('takes every due invoice to its result, publishes it once and lets it go', async () => {
    const repo = new InMemoryInvoiceRepository();
    const ids = await received(repo, 4);
    const { worker, published, heartbeat } = workerFor(repo);

    worker.start();
    await vi.waitFor(() => expect(published).toHaveLength(4));
    await worker.stop();

    expect(await statuses(repo, ids)).toEqual(Array(4).fill(InvoiceStatus.AUTHORIZED));
    expect(published.map((event) => event.invoiceId).sort()).toEqual([...ids].sort());
    expect(repo.locks.size).toBe(0);
    expect(heartbeat.beat).toHaveBeenCalled();
  });

  it('waits for the invoices in progress when stopped', async () => {
    const repo = new InMemoryInvoiceRepository();
    const [id] = await received(repo, 1);
    const reception = hangingReception();
    const { worker } = workerFor(repo, { sri: { validateXml: reception.validateXml } });
    worker.start();
    await vi.waitFor(() => expect(reception.validateXml).toHaveBeenCalled());

    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(false);

    reception.answer();
    await stopping;

    expect((await repo.getInvoiceById(id))!.status).toBe(InvoiceStatus.AUTHORIZED);
    expect(repo.locks.size).toBe(0);
  });

  it("keeps receiving sales while the SRI doesn't answer", async () => {
    const repo = new InMemoryInvoiceRepository();
    await received(repo, 1);
    const reception = hangingReception();
    const { worker } = workerFor(repo, { sri: { validateXml: reception.validateXml } });
    const kafka = fakeKafkaConsumer();
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
    worker.start();
    // Both slots: one waits for the SRI, the other has nothing to do yet
    await vi.waitFor(() => expect(reception.validateXml).toHaveBeenCalled());

    for (let n = 0; n < 20; n++) {
      await kafka.deliver(
        'sales.confirmed',
        makeSaleMessage(randomUUID(), makeSale({ sale_id: 100 + n })),
      );
    }

    // Each sale stored and its offset committed while the first invoice still waits
    expect(kafka.committed).toHaveLength(20);
    expect(reception.validateXml).toHaveBeenCalledTimes(1);
    reception.answer();
    await worker.stop();
  });

  it('puts aside an invoice whose job broke instead of taking it again at once', async () => {
    const repo = new InMemoryInvoiceRepository();
    const [id] = await received(repo, 1);
    const processor = {
      run: vi.fn(async () => {
        throw new Error('database down');
      }),
    } as unknown as InvoiceProcessor;
    const worker = new InvoiceWorker(repo, processor, { ...OPTIONS, concurrency: 1 });

    const before = Date.now();
    worker.start();
    await vi.waitFor(() => expect(processor.run).toHaveBeenCalled());
    await worker.stop();

    const nextAttemptAt = (await repo.getInvoiceById(id))!.nextAttemptAt!;
    expect(nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + OPTIONS.errorBackoffMs);
    expect(processor.run).toHaveBeenCalledTimes(1);
    expect(repo.locks.size).toBe(0);
  });
});
