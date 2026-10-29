import { describe, expect, it, vi } from 'vitest';

import { ReadyIssuer } from '#/modules/company-config/app/issuer-readiness';
import { RimpeRegime } from '#/modules/company-config/domain/company-config';
import { IssuerNotReadyError } from '#/modules/company-config/domain/readiness';
import { AuthorizeInvoiceCommand } from '#/modules/invoice/app/commands/authorize-invoice';
import { InvoiceCommand } from '#/modules/invoice/app/commands/command';
import { PrepareInvoiceCommand } from '#/modules/invoice/app/commands/prepare-invoice';
import { InvoiceEventHandler } from '#/modules/invoice/app/handlers/invoice-event.handler';
import { InvoiceRecoveryService } from '#/modules/invoice/app/services/invoice-recovery';
import { InvoiceDomainEvent } from '#/modules/invoice/domain/events';
import { Invoice, InvoiceStatus } from '#/modules/invoice/domain/invoice';
import { InvoiceSchemaValidator, SriAuthorizationPort } from '#/modules/invoice/domain/ports';
import {
  AuthorizationVoucher,
  AuthorizationVoucherStatus,
  AuthorizedVoucher,
} from '#/modules/invoice/domain/voucher';

import {
  InMemoryDocumentStorage,
  InMemoryInvoiceRepository,
  makeCertificate,
  makeConfig,
  makePoint,
  makeSale,
  PREPARE_OPTIONS,
  prepareCommand,
  readinessStub,
  REQUESTED_AT,
  RUC_B,
  TENANT_A,
  TENANT_B,
  xsdValidator,
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

async function storedPending(
  repo: InMemoryInvoiceRepository,
  sale = makeSale(),
  requestedAt: Date | null = REQUESTED_AT,
): Promise<Invoice> {
  const invoice = Invoice.receive('inv-1', makePoint(), sale, new Date(), requestedAt);
  await repo.createInvoice(invoice);
  return invoice;
}

const BUYER = {
  id: 9,
  name: 'Ferretería El Tornillo',
  tax_id: '1790012345001',
  tax_type: 'RUC' as const,
  email: null,
  phone: null,
  address: null,
};

// A sale of `total` paid in cash, to the final consumer unless it has a customer
function saleOf(total: string, customer: typeof BUYER | null = null) {
  const base = (Number(total) / 1.15).toFixed(2);
  const tax = (Number(total) - Number(base)).toFixed(2);
  return makeSale({
    customer,
    subtotal: base,
    total,
    items: [
      {
        ...makeSale().items[0],
        unit_price: base,
        subtotal: base,
        tax_amount: tax,
        invoice_base: base,
        invoice_tax: tax,
      },
    ],
    payments: [{ method: 'CASH', amount: total }],
  });
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
    const prepare = prepareCommand(readinessStub(READY), repo);

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
    const prepare = prepareCommand(readinessStub(NOT_READY), repo);

    const result = await handlerFor(repo, [[InvoiceStatus.PENDING, prepare]], producer).process(
      'inv-1',
    );

    expect(result?.status).toBe(InvoiceStatus.PENDING);
    expect(result?.issue?.code).toBe('CONFIG_MISSING');
    expect(result?.nextAttemptAt).toBeNull();
    expect(repo.sequences.size).toBe(0);
    expect(producer.sent).toEqual([]);
  });

  it('keeps an XML outside the SRI schema pending, without retrying it, with its number', async () => {
    const repo = new InMemoryInvoiceRepository();
    await storedPending(repo);
    const invalid: InvoiceSchemaValidator = {
      validate: vi.fn(async () => ({ valid: false, errors: ["line 3: Element 'ruc': bad"] })),
    };
    const prepare = prepareCommand(readinessStub(READY), repo, { validator: invalid });
    const handler = handlerFor(repo, [[InvoiceStatus.PENDING, prepare]]);

    await handler.process('inv-1');
    await handler.process('inv-1');

    const invoice = (await repo.getInvoiceById('inv-1'))!;
    expect(invoice.status).toBe(InvoiceStatus.PENDING);
    expect(invoice.issue).toMatchObject({ code: 'XML_SCHEMA_INVALID' });
    expect(invoice.issue?.message).toContain("line 3: Element 'ruc': bad");
    // Only a manual retry runs it again, and it keeps its number
    expect(invoice.nextAttemptAt).toBeNull();
    expect(invoice.attempts).toBe(2);
    expect(invoice.sequence).toBe('000000001');
    expect([...repo.sequences.values()]).toEqual([1]);
  });

  it('rejects a sale to the final consumer over the limit, without a number', async () => {
    const repo = new InMemoryInvoiceRepository();
    await storedPending(repo, saleOf('50.01'));
    const producer = producerStub();
    const prepare = prepareCommand(readinessStub(NOT_READY), repo);

    await handlerFor(repo, [[InvoiceStatus.PENDING, prepare]], producer).process('inv-1');

    const invoice = (await repo.getInvoiceById('inv-1'))!;
    expect(invoice.status).toBe(InvoiceStatus.REJECTED);
    expect(invoice.sequence).toBeNull();
    expect(repo.sequences.size).toBe(0);
    expect(producer.sent).toEqual([
      expect.objectContaining({
        type: 'InvoiceRejected',
        reason: expect.stringContaining("can't exceed USD 50.00 (this sale: USD 50.01)"),
      }),
    ]);
  });

  it.each([
    ['the final consumer up to the limit', saleOf('50.00')],
    ['an identified buyer over it', saleOf('80.00', BUYER)],
  ])('invoices %s', async (_case, sale) => {
    const repo = new InMemoryInvoiceRepository();
    await storedPending(repo, sale);

    await handlerFor(repo, [
      [InvoiceStatus.PENDING, prepareCommand(readinessStub(READY), repo)],
    ]).process('inv-1');

    expect((await repo.getInvoiceById('inv-1'))!.status).toBe(InvoiceStatus.CREATED);
  });

  it('takes the final consumer limit from the config', async () => {
    const repo = new InMemoryInvoiceRepository();
    await storedPending(repo, saleOf('50.00'));
    const prepare = prepareCommand(readinessStub(READY), repo, { finalConsumerMaxTotal: 20 });

    await handlerFor(repo, [[InvoiceStatus.PENDING, prepare]]).process('inv-1');

    expect((await repo.getInvoiceById('inv-1'))!.status).toBe(InvoiceStatus.REJECTED);
  });

  it("doesn't number a sale whose payments don't add up to its total", async () => {
    const repo = new InMemoryInvoiceRepository();
    // What the customer handed over, not what the payment applied (before S3.3)
    await storedPending(repo, makeSale({ payments: [{ method: 'CASH', amount: '20.00' }] }));
    const prepare = prepareCommand(readinessStub(READY), repo);

    const result = await handlerFor(repo, [[InvoiceStatus.PENDING, prepare]]).process('inv-1');

    expect(result?.status).toBe(InvoiceStatus.PENDING);
    expect(result?.issue).toMatchObject({ code: 'INVOICE_DATA_INVALID' });
    expect(result?.issue?.message).toContain('USD 20.00');
    expect(result?.nextAttemptAt).toBeNull();
    expect(result?.sequence).toBeNull();
  });

  it('dates the invoice when faclab-core asked to invoice the sale, in Ecuador', async () => {
    const repo = new InMemoryInvoiceRepository();
    // 02:00 UTC is still the day before in Ecuador
    await storedPending(repo, makeSale(), new Date('2026-10-02T02:00:00Z'));
    const prepare = prepareCommand(readinessStub(READY), repo);

    await handlerFor(repo, [[InvoiceStatus.PENDING, prepare]]).process('inv-1');

    const invoice = (await repo.getInvoiceById('inv-1'))!;
    expect(invoice.requireXml()).toContain('<fechaEmision>01/10/2026</fechaEmision>');
    expect(invoice.requireAccessCode().value.slice(0, 8)).toBe('01102026');
  });

  it.each([
    ['with INVOICE_EMISSION_DATE=prepared', 'prepared' as const, REQUESTED_AT],
    ['without a request date (received before S4.1)', 'sale' as const, null],
  ])('dates the invoice when its XML is built %s', async (_case, emissionDate, requestedAt) => {
    const repo = new InMemoryInvoiceRepository();
    await storedPending(repo, makeSale(), requestedAt);
    const prepare = new PrepareInvoiceCommand(
      readinessStub(READY),
      repo,
      xsdValidator,
      { ...PREPARE_OPTIONS, emissionDate },
      () => new Date('2026-10-20T15:00:00Z'),
    );

    await handlerFor(repo, [[InvoiceStatus.PENDING, prepare]]).process('inv-1');

    expect((await repo.getInvoiceById('inv-1'))!.requireXml()).toContain(
      '<fechaEmision>20/10/2026</fechaEmision>',
    );
  });

  it('puts a random numeric code in the access code, kept with the number', async () => {
    const repo = new InMemoryInvoiceRepository();
    await storedPending(repo);
    const prepare = prepareCommand(readinessStub(READY), repo);

    await handlerFor(repo, [[InvoiceStatus.PENDING, prepare]]).process('inv-1');

    const invoice = (await repo.getInvoiceById('inv-1'))!;
    expect(invoice.numericCode).toMatch(/^\d{8}$/);
    expect(invoice.requireAccessCode().value.slice(39, 47)).toBe(invoice.numericCode);
  });

  it.each([
    [
      'a RIMPE entrepreneur',
      { rimpeRegime: RimpeRegime.ENTREPRENEUR },
      '<contribuyenteRimpe>CONTRIBUYENTE RÉGIMEN RIMPE</contribuyenteRimpe>',
    ],
    [
      'a RIMPE popular business',
      { rimpeRegime: RimpeRegime.POPULAR_BUSINESS },
      '<contribuyenteRimpe>CONTRIBUYENTE NEGOCIO POPULAR - RÉGIMEN RIMPE</contribuyenteRimpe>',
    ],
    [
      'a special taxpayer',
      { specialTaxpayerResolution: '5368' },
      '<contribuyenteEspecial>5368</contribuyenteEspecial>',
    ],
    [
      'a withholding agent',
      { withholdingAgentResolution: '1' },
      '<agenteRetencion>1</agenteRetencion>',
    ],
  ])('writes the legend of %s, and the XML passes the XSD', async (_case, profile, legend) => {
    const repo = new InMemoryInvoiceRepository();
    await storedPending(repo);
    const issuer = { config: makeConfig(profile), certificate: makeCertificate() };

    await handlerFor(repo, [
      [InvoiceStatus.PENDING, prepareCommand(readinessStub(issuer), repo)],
    ]).process('inv-1');

    const invoice = (await repo.getInvoiceById('inv-1'))!;
    // Built means it passed the XSD: an invalid XML stays pending with an issue
    expect(invoice.status).toBe(InvoiceStatus.CREATED);
    expect(invoice.requireXml()).toContain(legend);
  });

  it('writes the RUC of the invoicing system provider when configured', async () => {
    const repo = new InMemoryInvoiceRepository();
    await storedPending(repo);
    const prepare = prepareCommand(readinessStub(READY), repo, { providerRuc: RUC_B });

    await handlerFor(repo, [[InvoiceStatus.PENDING, prepare]]).process('inv-1');

    const invoice = (await repo.getInvoiceById('inv-1'))!;
    expect(invoice.status).toBe(InvoiceStatus.CREATED);
    expect(invoice.requireXml()).toContain(
      `<campoAdicional nombre="RUC Proveedor">${RUC_B}</campoAdicional>`,
    );
  });

  it('builds the XML with the establishment, address and emission point of the sale', async () => {
    const repo = new InMemoryInvoiceRepository();
    const point = makePoint({
      establishment: '002',
      emissionPoint: '003',
      establishmentAddress: 'Av. de la Prensa N58-12, Quito',
    });
    await repo.createInvoice(Invoice.receive('inv-1', point, makeSale()));
    const prepare = prepareCommand(readinessStub(READY), repo);

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
    const handler = handlerFor(repo, [[InvoiceStatus.PENDING, prepareCommand(readiness, repo)]]);

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
    const prepare = prepareCommand(readinessStub(READY), repo);

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
    const prepare = prepareCommand(readinessStub(READY), repo);

    await handlerFor(repo, [[InvoiceStatus.PENDING, prepare]]).process('inv-1');

    expect((await repo.getInvoiceById('inv-1'))!.requireXml()).not.toContain('dirEstablecimiento');
  });
});

describe('AuthorizeInvoiceCommand through the event handler', () => {
  async function storedSent(repo: InMemoryInvoiceRepository): Promise<string> {
    const invoice = await storedPending(repo);
    const prepare = prepareCommand(readinessStub(READY), repo);
    await prepare.execute(invoice);
    invoice.sign('<factura firmada/>');
    invoice.markAsSent([]);
    await repo.updateInvoice(invoice);
    return invoice.requireAccessCode().value;
  }

  const AUTHORIZED_AT = '2026-10-09T10:01:02-05:00';

  function authorizer(
    status: AuthorizationVoucherStatus,
    authorized: Partial<AuthorizedVoucher> | null = {},
  ): SriAuthorizationPort {
    return {
      authorizeXml: vi.fn(
        async (code: string) =>
          new AuthorizationVoucher(
            status,
            code,
            status === AuthorizationVoucherStatus.AUTHORIZED ? new Date(AUTHORIZED_AT) : null,
            [],
            status === AuthorizationVoucherStatus.AUTHORIZED && authorized
              ? {
                  number: code,
                  date: AUTHORIZED_AT,
                  environment: 'PRUEBAS',
                  voucherXml: '<factura firmada/>',
                  ...authorized,
                }
              : null,
          ),
      ),
    };
  }

  it('waits instead of rejecting while the SRI is still processing', async () => {
    const repo = new InMemoryInvoiceRepository();
    await storedSent(repo);
    const command = new AuthorizeInvoiceCommand(
      authorizer(AuthorizationVoucherStatus.PROCESSING),
      repo,
      new InMemoryDocumentStorage(),
    );

    const result = await handlerFor(repo, [[InvoiceStatus.SENT, command]]).process('inv-1');

    expect(result?.status).toBe(InvoiceStatus.SENT);
    expect(result?.issue?.code).toBe('SRI_PROCESSING');
    expect(result?.nextAttemptAt).not.toBeNull();
  });

  it('keeps the authorized XML, then authorizes and publishes the event core listens to', async () => {
    const repo = new InMemoryInvoiceRepository();
    const accessCode = await storedSent(repo);
    const storage = new InMemoryDocumentStorage();
    const producer = producerStub();
    const command = new AuthorizeInvoiceCommand(
      authorizer(AuthorizationVoucherStatus.AUTHORIZED),
      repo,
      storage,
    );

    await handlerFor(repo, [[InvoiceStatus.SENT, command]], producer).process('inv-1');

    const invoice = (await repo.getInvoiceById('inv-1'))!;
    const key = `tenants/${TENANT_A}/invoices/2026/${accessCode}.xml`;
    expect(invoice.status).toBe(InvoiceStatus.AUTHORIZED);
    expect(invoice.authorization).toEqual({
      number: accessCode,
      authorizedAt: new Date(AUTHORIZED_AT),
      xmlKey: key,
    });
    expect([...storage.objects.keys()]).toEqual([key]);
    const stored = storage.objects.get(key)!;
    expect(stored.contentType).toBe('application/xml');
    expect(stored.body).toContain(`<numeroAutorizacion>${accessCode}</numeroAutorizacion>`);
    expect(stored.body).toContain(`<fechaAutorizacion>${AUTHORIZED_AT}</fechaAutorizacion>`);
    expect(stored.body).toContain('<![CDATA[<factura firmada/>]]>');
    expect(producer.sent.map((e) => e.type)).toEqual(['InvoiceAuthorized']);
  });

  it('stays sent and is retried when the authorized XML could not be kept', async () => {
    const repo = new InMemoryInvoiceRepository();
    await storedSent(repo);
    const storage = new InMemoryDocumentStorage();
    storage.failing = true;
    const producer = producerStub();
    const command = new AuthorizeInvoiceCommand(
      authorizer(AuthorizationVoucherStatus.AUTHORIZED),
      repo,
      storage,
    );
    const handler = handlerFor(repo, [[InvoiceStatus.SENT, command]], producer);

    const result = await handler.process('inv-1');

    expect(result?.status).toBe(InvoiceStatus.SENT);
    expect(result?.issue?.code).toBe('STORAGE_UNAVAILABLE');
    expect(result?.nextAttemptAt).not.toBeNull();
    expect(result?.authorization).toBeNull();
    expect(producer.sent).toEqual([]);

    // The retry asks the SRI again and keeps it
    storage.failing = false;
    expect((await handler.process('inv-1'))?.status).toBe(InvoiceStatus.AUTHORIZED);
    expect(storage.objects.size).toBe(1);
  });

  it('asks again when the SRI authorizes without the number or the voucher', async () => {
    const repo = new InMemoryInvoiceRepository();
    await storedSent(repo);
    const command = new AuthorizeInvoiceCommand(
      authorizer(AuthorizationVoucherStatus.AUTHORIZED, null),
      repo,
      new InMemoryDocumentStorage(),
    );

    const result = await handlerFor(repo, [[InvoiceStatus.SENT, command]]).process('inv-1');

    expect(result?.status).toBe(InvoiceStatus.SENT);
    expect(result?.issue?.code).toBe('SRI_UNAVAILABLE');
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
    // The invoice itself is wrong: only "retry all" runs it again
    await store(repo, 'invalid', (i) =>
      i.recordIssue({ code: 'XML_SCHEMA_INVALID', message: 'x', at: minutesAgo(90) }),
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
    expect(all.processed.sort()).toEqual([
      'blocked',
      'invalid',
      'stale',
      'transient-due',
      'transient-later',
    ]);
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
