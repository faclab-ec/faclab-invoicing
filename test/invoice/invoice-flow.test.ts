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
  InMemoryInvoiceRepository,
  makeCertificate,
  makeConfig,
  makePoint,
  makeSale,
  readinessStub,
  RUC_B,
  TENANT_A,
  TENANT_B,
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
  const invoice = Invoice.receive('inv-1', makePoint(), makeSale());
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
    const prepare = new PrepareInvoiceCommand(readinessStub(READY), repo);

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
    const prepare = new PrepareInvoiceCommand(readinessStub(NOT_READY), repo);

    const result = await handlerFor(repo, [[InvoiceStatus.PENDING, prepare]], producer).process(
      'inv-1',
    );

    expect(result?.status).toBe(InvoiceStatus.PENDING);
    expect(result?.issue?.code).toBe('CONFIG_MISSING');
    expect(result?.nextAttemptAt).toBeNull();
    expect(repo.sequences.size).toBe(0);
    expect(producer.sent).toEqual([]);
  });

  it('reuses the sequence when building the XML failed after assigning it', async () => {
    const repo = new InMemoryInvoiceRepository();
    await storedPending(repo);
    // The sale id doesn't fit in the access code: building fails after the sequence
    const brokenSale = makeSale({ sale_id: 123456789 });
    const broken = Invoice.receive('inv-2', makePoint(), brokenSale);
    await repo.createInvoice(broken);
    const prepare = new PrepareInvoiceCommand(readinessStub(READY), repo);
    const handler = handlerFor(repo, [[InvoiceStatus.PENDING, prepare]]);

    await handler.process('inv-2');
    await handler.process('inv-2');

    const invoice = (await repo.getInvoiceById('inv-2'))!;
    expect(invoice.status).toBe(InvoiceStatus.PENDING);
    expect(invoice.issue?.code).toBe('UNEXPECTED_ERROR');
    expect(invoice.attempts).toBe(2);
    expect(invoice.sequence).toBe('000000001');
    expect([...repo.sequences.values()]).toEqual([1]);
  });

  it('builds the XML with the establishment, address and emission point of the sale', async () => {
    const repo = new InMemoryInvoiceRepository();
    const point = makePoint({
      establishment: '002',
      emissionPoint: '003',
      establishmentAddress: 'Av. de la Prensa N58-12, Quito',
    });
    await repo.createInvoice(Invoice.receive('inv-1', point, makeSale()));
    const prepare = new PrepareInvoiceCommand(readinessStub(READY), repo);

    await handlerFor(repo, [[InvoiceStatus.PENDING, prepare]]).process('inv-1');

    const invoice = (await repo.getInvoiceById('inv-1'))!;
    const xml = invoice.requireXml();
    expect(xml).toContain('<estab>002</estab>');
    expect(xml).toContain('<ptoEmi>003</ptoEmi>');
    expect(xml).toContain(
      '<dirEstablecimiento>Av. de la Prensa N58-12, Quito</dirEstablecimiento>',
    );
    expect(xml).toContain('<dirMatriz>Quito</dirMatriz>');
    expect(invoice.requireAccessCode().value.slice(24, 39)).toBe('002003000000001');
  });

  it('numbers each company, establishment and emission point on its own', async () => {
    const repo = new InMemoryInvoiceRepository();
    const points = [
      makePoint(),
      makePoint(),
      makePoint({ emissionPoint: '002' }),
      makePoint({ tenantId: TENANT_B, issuerRuc: RUC_B }),
    ];
    for (const [n, point] of points.entries()) {
      await repo.createInvoice(Invoice.receive(`inv-${n}`, point, makeSale({ sale_id: n + 1 })));
    }
    const readiness = readinessStub({
      [TENANT_A]: READY,
      [TENANT_B]: {
        config: makeConfig({ tenantId: TENANT_B, taxId: RUC_B }),
        certificate: makeCertificate({ tenantId: TENANT_B, taxIds: [RUC_B] }),
      },
    });
    const handler = handlerFor(repo, [
      [InvoiceStatus.PENDING, new PrepareInvoiceCommand(readiness, repo)],
    ]);

    for (const n of points.keys()) await handler.process(`inv-${n}`);

    const sequences = await Promise.all(
      points.map(async (_, n) => (await repo.getInvoiceById(`inv-${n}`))!.sequence),
    );
    expect(sequences).toEqual(['000000001', '000000002', '000000001', '000000001']);
    const companyB = (await repo.getInvoiceById('inv-3'))!;
    expect(companyB.requireXml()).toContain(`<ruc>${RUC_B}</ruc>`);
  });

  it("waits while the sale names a RUC other than its company's profile", async () => {
    const repo = new InMemoryInvoiceRepository();
    await repo.createInvoice(
      Invoice.receive('inv-1', makePoint({ issuerRuc: '1790000000001' }), makeSale()),
    );
    const prepare = new PrepareInvoiceCommand(readinessStub(READY), repo);

    const result = await handlerFor(repo, [[InvoiceStatus.PENDING, prepare]]).process('inv-1');

    expect(result?.status).toBe(InvoiceStatus.PENDING);
    expect(result?.issue?.code).toBe('ISSUER_RUC_MISMATCH');
    expect(result?.sequence).toBeNull();
    expect(result?.nextAttemptAt).toBeNull();
  });

  it('leaves dirEstablecimiento out when the branch has no address', async () => {
    const repo = new InMemoryInvoiceRepository();
    await repo.createInvoice(
      Invoice.receive('inv-1', makePoint({ establishmentAddress: null }), makeSale()),
    );
    const prepare = new PrepareInvoiceCommand(readinessStub(READY), repo);

    await handlerFor(repo, [[InvoiceStatus.PENDING, prepare]]).process('inv-1');

    expect((await repo.getInvoiceById('inv-1'))!.requireXml()).not.toContain('dirEstablecimiento');
  });
});

describe('AuthorizeInvoiceCommand through the event handler', () => {
  async function storedSent(repo: InMemoryInvoiceRepository) {
    const invoice = await storedPending(repo);
    const prepare = new PrepareInvoiceCommand(readinessStub(READY), repo);
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
  let saleId = 100;

  async function store(
    repo: InMemoryInvoiceRepository,
    id: string,
    setup: (i: Invoice) => void,
    point = makePoint(),
  ) {
    // One sale per invoice: a sale has a single active invoice
    const sale = makeSale({ sale_id: ++saleId });
    const invoice = Invoice.receive(id, point, sale, new Date(NOW.getTime() - 60 * 60_000));
    setup(invoice);
    expect(await repo.createInvoice(invoice)).toBe(true);
  }

  function recovery(
    repo: InMemoryInvoiceRepository,
    ready: boolean | Parameters<typeof readinessStub>[0],
  ) {
    const processed: string[] = [];
    const handler = {
      process: vi.fn(async (id: string) => {
        processed.push(id);
        return null;
      }),
    } as unknown as InvoiceEventHandler;
    const service = new InvoiceRecoveryService(
      repo,
      readinessStub(typeof ready === 'boolean' ? (ready ? READY : NOT_READY) : ready),
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

  it("doesn't let a company whose issuer can't invoice hold back another one", async () => {
    const repo = new InMemoryInvoiceRepository();
    const waiting = (i: Invoice) =>
      i.recordIssue({ code: 'CERTIFICATE_NOT_SELECTED', message: 'x', at: NOW });
    await store(repo, 'of-a', waiting);
    await store(repo, 'of-b', waiting, makePoint({ tenantId: TENANT_B, issuerRuc: RUC_B }));

    // A has no certificate; B is ready
    const { service, processed } = recovery(repo, {
      [TENANT_A]: NOT_READY,
      [TENANT_B]: {
        config: makeConfig({ tenantId: TENANT_B, taxId: RUC_B }),
        certificate: makeCertificate({ tenantId: TENANT_B, taxIds: [RUC_B] }),
      },
    });
    await service.run();

    expect(processed).toEqual(['of-b']);
  });

  it('retries a sale of another RUC only once the profile has that RUC', async () => {
    const repo = new InMemoryInvoiceRepository();
    await store(
      repo,
      'other-ruc',
      (i) => i.recordIssue({ code: 'ISSUER_RUC_MISMATCH', message: 'x', at: NOW }),
      makePoint({ issuerRuc: RUC_B }),
    );

    const unchanged = recovery(repo, true);
    await unchanged.service.run({ all: true });
    expect(unchanged.processed).toEqual([]);

    const fixed = recovery(repo, {
      config: makeConfig({ taxId: RUC_B }),
      certificate: makeCertificate(),
    });
    await fixed.service.run();
    expect(fixed.processed).toEqual(['other-ruc']);
  });

  it('runs only the invoices of the company that changed', async () => {
    const repo = new InMemoryInvoiceRepository();
    const waiting = (i: Invoice) =>
      i.recordIssue({ code: 'CONFIG_MISSING', message: 'x', at: NOW });
    await store(repo, 'of-a', waiting);
    await store(repo, 'of-b', waiting, makePoint({ tenantId: TENANT_B, issuerRuc: RUC_B }));

    const { service, processed } = recovery(repo, true);
    await service.run({ tenantId: TENANT_B });

    expect(processed).toEqual(['of-b']);
  });
});
