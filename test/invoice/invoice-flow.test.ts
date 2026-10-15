import { describe, expect, it, vi } from 'vitest';

import { ReadyIssuer } from '#/modules/company-config/app/issuer-readiness';
import { IssuerNotReadyError } from '#/modules/company-config/domain/readiness';
import { AuthorizeInvoiceCommand } from '#/modules/invoice/app/commands/authorize-invoice';
import { InvoiceCommand } from '#/modules/invoice/app/commands/command';
import { PrepareInvoiceCommand } from '#/modules/invoice/app/commands/prepare-invoice';
import { InvoiceEventHandler } from '#/modules/invoice/app/handlers/invoice-event.handler';
import { InvoiceRecoveryService } from '#/modules/invoice/app/services/invoice-recovery';
import { InvoiceDomainEvent } from '#/modules/invoice/domain/events';
import { Invoice, InvoiceStatus } from '#/modules/invoice/domain/invoice';
import { SriAuthorizationPort } from '#/modules/invoice/domain/ports';
import { AuthorizationVoucher, AuthorizationVoucherStatus } from '#/modules/invoice/domain/voucher';

import {
  configRepoStub,
  InMemoryInvoiceRepository,
  makeCertificate,
  makeConfig,
  makeSale,
  readinessStub,
} from '../helpers';

function producerStub() {
  const sent: InvoiceDomainEvent[] = [];
  return { sent, sendMessage: vi.fn(async (event: InvoiceDomainEvent) => void sent.push(event)) };
}

const READY: ReadyIssuer = { config: makeConfig(), certificate: makeCertificate() };
const NOT_READY = new IssuerNotReadyError(
  'CONFIG_MISSING',
  'The company fiscal config has not been saved',
);

async function storedPending(repo: InMemoryInvoiceRepository): Promise<Invoice> {
  const invoice = Invoice.receive('inv-1', makeSale());
  await repo.createInvoice(invoice);
  return invoice;
}

function handlerFor(
  repo: InMemoryInvoiceRepository,
  commands: [InvoiceStatus, InvoiceCommand][],
  producer = producerStub(),
) {
  return new InvoiceEventHandler(repo, new Map(commands), producer);
}

describe('PrepareInvoiceCommand through the event handler', () => {
  it('builds the XML when the issuer is ready', async () => {
    const repo = new InMemoryInvoiceRepository();
    await storedPending(repo);
    const producer = producerStub();
    const prepare = new PrepareInvoiceCommand(readinessStub(READY), configRepoStub(), repo);

    await handlerFor(repo, [[InvoiceStatus.PENDING, prepare]], producer).process('inv-1');

    const invoice = (await repo.getInvoiceById('inv-1'))!;
    expect(invoice.status).toBe(InvoiceStatus.CREATED);
    expect(invoice.sequence).toBe('000000001');
    expect(invoice.signatureId).toBe('cert-1');
    expect(invoice.requireXml()).toContain('<secuencial>000000001</secuencial>');
    expect(invoice.requireAccessCode().value).toHaveLength(49);
    expect(producer.sent.map((e) => e.type)).toEqual(['InvoiceCreated']);
  });

  it('keeps the invoice pending with the reason when the issuer is not ready', async () => {
    const repo = new InMemoryInvoiceRepository();
    await storedPending(repo);
    const producer = producerStub();
    const configRepo = configRepoStub();
    const prepare = new PrepareInvoiceCommand(readinessStub(NOT_READY), configRepo, repo);

    const result = await handlerFor(repo, [[InvoiceStatus.PENDING, prepare]], producer).process(
      'inv-1',
    );

    expect(result?.status).toBe(InvoiceStatus.PENDING);
    expect(result?.issue?.code).toBe('CONFIG_MISSING');
    expect(result?.nextAttemptAt).toBeNull();
    expect(configRepo.nextInvoiceSequence).not.toHaveBeenCalled();
    expect(producer.sent).toEqual([]);
  });

  it('reuses the sequence when building the XML failed after assigning it', async () => {
    const repo = new InMemoryInvoiceRepository();
    await storedPending(repo);
    const configRepo = configRepoStub();
    // The sale id doesn't fit in the access code: building fails after the sequence
    const brokenSale = makeSale({ sale_id: 123456789 });
    const broken = Invoice.receive('inv-2', brokenSale);
    await repo.createInvoice(broken);
    const prepare = new PrepareInvoiceCommand(readinessStub(READY), configRepo, repo);
    const handler = handlerFor(repo, [[InvoiceStatus.PENDING, prepare]]);

    await handler.process('inv-2');
    await handler.process('inv-2');

    const invoice = (await repo.getInvoiceById('inv-2'))!;
    expect(invoice.status).toBe(InvoiceStatus.PENDING);
    expect(invoice.issue?.code).toBe('UNEXPECTED_ERROR');
    expect(invoice.attempts).toBe(2);
    expect(invoice.sequence).toBe('000000001');
    expect(configRepo.nextInvoiceSequence).toHaveBeenCalledTimes(1);
  });
});

describe('AuthorizeInvoiceCommand through the event handler', () => {
  async function storedSent(repo: InMemoryInvoiceRepository) {
    const invoice = await storedPending(repo);
    const prepare = new PrepareInvoiceCommand(readinessStub(READY), configRepoStub(), repo);
    await prepare.execute(invoice);
    invoice.sign('<factura firmada/>');
    invoice.markAsSent([]);
    await repo.updateInvoice(invoice);
  }

  function authorizer(status: AuthorizationVoucherStatus): SriAuthorizationPort {
    return {
      authorizeXml: vi.fn(async () => new AuthorizationVoucher(status, 'code', null, [])),
    };
  }

  it('waits instead of rejecting while the SRI is still processing', async () => {
    const repo = new InMemoryInvoiceRepository();
    await storedSent(repo);
    const command = new AuthorizeInvoiceCommand(
      authorizer(AuthorizationVoucherStatus.PROCESSING),
      repo,
    );

    const result = await handlerFor(repo, [[InvoiceStatus.SENT, command]]).process('inv-1');

    expect(result?.status).toBe(InvoiceStatus.SENT);
    expect(result?.issue?.code).toBe('SRI_PROCESSING');
    expect(result?.nextAttemptAt).not.toBeNull();
  });

  it('authorizes and publishes the event core listens to', async () => {
    const repo = new InMemoryInvoiceRepository();
    await storedSent(repo);
    const producer = producerStub();
    const command = new AuthorizeInvoiceCommand(
      authorizer(AuthorizationVoucherStatus.AUTHORIZED),
      repo,
    );

    await handlerFor(repo, [[InvoiceStatus.SENT, command]], producer).process('inv-1');

    expect((await repo.getInvoiceById('inv-1'))?.status).toBe(InvoiceStatus.AUTHORIZED);
    expect(producer.sent.map((e) => e.type)).toEqual(['InvoiceAuthorized']);
  });
});

describe('InvoiceRecoveryService', () => {
  const NOW = new Date('2026-10-09T15:00:00Z');

  async function store(repo: InMemoryInvoiceRepository, id: string, setup: (i: Invoice) => void) {
    const invoice = Invoice.receive(id, makeSale(), new Date(NOW.getTime() - 60 * 60_000));
    setup(invoice);
    await repo.createInvoice(invoice);
  }

  function recovery(repo: InMemoryInvoiceRepository, ready: boolean) {
    const processed: string[] = [];
    const handler = {
      process: vi.fn(async (id: string) => {
        processed.push(id);
        return null;
      }),
    } as unknown as InvoiceEventHandler;
    const service = new InvoiceRecoveryService(
      repo,
      readinessStub(ready ? READY : NOT_READY),
      handler,
      5 * 60_000,
      () => NOW,
    );
    return { service, processed };
  }

  it('picks what is due and leaves the rest', async () => {
    const repo = new InMemoryInvoiceRepository();
    const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
    await store(repo, 'blocked', (i) =>
      i.recordIssue({ code: 'CERTIFICATE_EXPIRED', message: 'x', at: minutesAgo(30) }),
    );
    await store(repo, 'transient-due', (i) =>
      i.recordIssue({ code: 'SRI_UNAVAILABLE', message: 'x', at: minutesAgo(2) }),
    );
    await store(repo, 'transient-later', (i) =>
      i.recordIssue({ code: 'SRI_UNAVAILABLE', message: 'x', at: NOW }),
    );
    // No issue and still for an hour: its event was lost
    await store(repo, 'stale', () => undefined);

    const notReady = recovery(repo, false);
    await notReady.service.run();
    expect(notReady.processed.sort()).toEqual(['stale', 'transient-due']);

    const ready = recovery(repo, true);
    await ready.service.run();
    expect(ready.processed.sort()).toEqual(['blocked', 'stale', 'transient-due']);

    const all = recovery(repo, true);
    await all.service.run({ all: true });
    expect(all.processed.sort()).toEqual(['blocked', 'stale', 'transient-due', 'transient-later']);
  });
});
