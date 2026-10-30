import { describe, expect, it, vi } from 'vitest';

import { ReadyIssuer } from '#/modules/company-config/app/issuer-readiness';
import {
  RetryInvoiceCommand,
  RetryInvoicesCommand,
} from '#/modules/invoice/app/commands/retry-invoice';
import { InvoiceProcessor } from '#/modules/invoice/app/services/invoice-processor';
import { InvoiceRecoveryService } from '#/modules/invoice/app/services/invoice-recovery';
import { Invoice, InvoiceStatus } from '#/modules/invoice/domain/invoice';
import { ConflictError } from '#/shared/errors/app-error';

import {
  InMemoryInvoiceRepository,
  invoiceSteps,
  makeCertificate,
  makeConfig,
  makePoint,
  makeSale,
  readinessStub,
  TENANT_A,
  TENANT_B,
} from '../helpers';

const READY: ReadyIssuer = { config: makeConfig(), certificate: makeCertificate() };
const LEASE = { holder: 'api-1:api', leaseMs: 60_000 };

async function retryCommand() {
  const repo = new InMemoryInvoiceRepository();
  await repo.createInvoice(Invoice.receive('inv-1', makePoint(), makeSale()));
  const readiness = readinessStub(READY);
  // The API's processor: no producer, the worker publishes the result
  const processor = new InvoiceProcessor(
    repo,
    repo,
    invoiceSteps(repo, readiness),
    readiness,
    null,
  );
  const run = vi.spyOn(processor, 'run');
  return { repo, run, command: new RetryInvoiceCommand(repo, repo, readiness, processor, LEASE) };
}

describe('RetryInvoiceCommand', () => {
  it('runs one step of an invoice nobody holds and lets it go', async () => {
    const { repo, command } = await retryCommand();

    const invoice = await command.execute(TENANT_A, 'inv-1');

    expect(invoice.status).toBe(InvoiceStatus.CREATED);
    // The worker goes on with the next steps
    expect(invoice.nextAttemptAt).not.toBeNull();
    expect(repo.locks.size).toBe(0);
  });

  it('answers INVOICE_IN_PROGRESS while a worker runs one of its steps', async () => {
    const { repo, run, command } = await retryCommand();
    repo.locks.set('inv-1', { holder: 'worker-1:1', until: Date.now() + 60_000 });

    const error = await command.execute(TENANT_A, 'inv-1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ code: 'INVOICE_IN_PROGRESS' });
    expect(run).not.toHaveBeenCalled();
    // Still the worker's
    expect(repo.locks.get('inv-1')?.holder).toBe('worker-1:1');
  });

  it("refuses a finished invoice and doesn't find another company's", async () => {
    const { repo, command } = await retryCommand();
    const stored = (await repo.getInvoiceById('inv-1'))!;
    stored.reject(['NO AUTORIZADO']);
    await repo.updateInvoice(stored);

    await expect(command.execute(TENANT_A, 'inv-1')).rejects.toMatchObject({
      code: 'INVOICE_NOT_RETRYABLE',
    });
    await expect(command.execute(TENANT_B, 'inv-1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(repo.locks.size).toBe(0);
  });
});

describe('RetryInvoicesCommand', () => {
  it("puts back the company's invoices that need attention and says how many", async () => {
    const repo = new InMemoryInvoiceRepository();
    for (const [id, saleId] of [
      ['failed', 1],
      ['moving', 2],
    ] as const) {
      await repo.createInvoice(Invoice.receive(id, makePoint(), makeSale({ sale_id: saleId })));
    }
    const failed = (await repo.getInvoiceById('failed'))!;
    failed.recordIssue({ code: 'XML_SCHEMA_INVALID', message: 'x', at: new Date() });
    await repo.updateInvoice(failed);
    const readiness = readinessStub(READY);

    const queued = await new RetryInvoicesCommand(
      readiness,
      new InvoiceRecoveryService(repo, readiness),
    ).execute(TENANT_A);

    // The other one is due already
    expect(queued).toBe(1);
    expect((await repo.getInvoiceById('failed'))!.nextAttemptAt).not.toBeNull();
    expect(readiness.invalidate).toHaveBeenCalledWith(TENANT_A);
  });
});
