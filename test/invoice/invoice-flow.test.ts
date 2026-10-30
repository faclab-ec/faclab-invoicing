import { describe, expect, it, vi } from 'vitest';

import { ReadyIssuer } from '#/modules/company-config/app/issuer-readiness';
import { RimpeRegime } from '#/modules/company-config/domain/company-config';
import { IssuerNotReadyError } from '#/modules/company-config/domain/readiness';
import { AuthorizeInvoiceCommand } from '#/modules/invoice/app/commands/authorize-invoice';
import { InvoiceCommand } from '#/modules/invoice/app/commands/command';
import { PrepareInvoiceCommand } from '#/modules/invoice/app/commands/prepare-invoice';
import { InvoiceProcessor } from '#/modules/invoice/app/services/invoice-processor';
import { InvoiceRecoveryService } from '#/modules/invoice/app/services/invoice-recovery';
import { InvoiceDelivery } from '#/modules/invoice/domain/delivery';
import { InvoiceResultEvent } from '#/modules/invoice/domain/events';
import { Invoice, InvoiceStatus } from '#/modules/invoice/domain/invoice';
import { InvoiceSchemaValidator, SriAuthorizationPort } from '#/modules/invoice/domain/ports';
import { ConcurrentUpdateError } from '#/modules/invoice/domain/repository';
import {
  AuthorizationVoucher,
  AuthorizationVoucherStatus,
  AuthorizedVoucher,
} from '#/modules/invoice/domain/voucher';

import {
  InMemoryDocumentStorage,
  InMemoryInvoiceRepository,
  invoiceSteps,
  makeAuthorizedInvoice,
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
  const sent: InvoiceResultEvent[] = [];
  return { sent, sendMessage: vi.fn(async (event: InvoiceResultEvent) => void sent.push(event)) };
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

/** One step at a time, as a manual retry runs them; publishes the result once final */
function handlerFor(
  repo: InMemoryInvoiceRepository,
  commands: [InvoiceStatus, InvoiceCommand][],
  producer = producerStub(),
) {
  const processor = new InvoiceProcessor(
    repo,
    repo,
    new Map(commands),
    readinessStub(READY),
    producer,
  );
  return { process: (id: string) => processor.run(id, { maxSteps: 1 }) };
}

describe('PrepareInvoiceCommand through the processor', () => {
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
    // Due for its signature; faclab-core only hears of the result
    expect(invoice.nextAttemptAt).not.toBeNull();
    expect(producer.sent).toEqual([]);
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

describe('AuthorizeInvoiceCommand through the processor', () => {
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
    // Nothing left to do with it
    expect(invoice.resultPublishedAt).not.toBeNull();
    expect(invoice.nextAttemptAt).toBeNull();
  });

  it('starts the delivery to the buyer with the authorization, with the trace of the step', async () => {
    const repo = new InMemoryInvoiceRepository();
    const sale = makeSale({
      customer: {
        id: 1,
        name: 'Construcciones Andinas',
        tax_id: '1790012345001',
        tax_type: 'RUC',
        email: ' compras@andinas.ec ',
        phone: null,
        address: null,
      },
    });
    const invoice = await storedPending(repo, sale);
    await prepareCommand(readinessStub(READY), repo).execute(invoice);
    invoice.sign('<factura firmada/>');
    invoice.markAsSent([]);
    await repo.updateInvoice(invoice);
    const trace = { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' };
    const command = new AuthorizeInvoiceCommand(
      authorizer(AuthorizationVoucherStatus.AUTHORIZED),
      repo,
      new InMemoryDocumentStorage(),
      () => trace,
    );

    await command.execute((await repo.getInvoiceById('inv-1'))!);

    const deliveries = [...repo.deliveries.records.values()];
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      tenantId: TENANT_A,
      invoiceId: 'inv-1',
      kind: 'authorization',
      recipient: 'compras@andinas.ec',
      requestedBy: null,
      status: 'pending',
      traceContext: trace,
    });
    // An authorization saved again (a retried step) doesn't start another one
    const authorized = (await repo.getInvoiceById('inv-1'))!;
    await repo.saveAuthorized(authorized, InvoiceDelivery.forAuthorization(authorized));
    expect(repo.deliveries.records.size).toBe(1);
  });

  it('starts no delivery when the authorization could not be saved, nor for a rejection', async () => {
    const repo = new InMemoryInvoiceRepository();
    await storedSent(repo);
    const stale = (await repo.getInvoiceById('inv-1'))!;
    // Someone else saved it meanwhile
    await repo.updateInvoice((await repo.getInvoiceById('inv-1'))!);
    const authorize = new AuthorizeInvoiceCommand(
      authorizer(AuthorizationVoucherStatus.AUTHORIZED),
      repo,
      new InMemoryDocumentStorage(),
    );

    await expect(authorize.execute(stale)).rejects.toBeInstanceOf(ConcurrentUpdateError);
    expect(repo.deliveries.records.size).toBe(0);

    const reject = new AuthorizeInvoiceCommand(
      authorizer(AuthorizationVoucherStatus.REJECTED),
      repo,
      new InMemoryDocumentStorage(),
    );
    await reject.execute((await repo.getInvoiceById('inv-1'))!);
    expect((await repo.getInvoiceById('inv-1'))!.status).toBe(InvoiceStatus.REJECTED);
    expect(repo.deliveries.records.size).toBe(0);
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

describe('InvoiceProcessor', () => {
  const sriCommands = (repo: InMemoryInvoiceRepository) => invoiceSteps(repo, readinessStub(READY));

  const LEASE = { holder: 'worker-1:1', leaseMs: 60_000 };

  it('runs every step until the invoice is final and publishes its result once', async () => {
    const repo = new InMemoryInvoiceRepository();
    await storedPending(repo);
    const producer = producerStub();
    const processor = new InvoiceProcessor(
      repo,
      repo,
      sriCommands(repo),
      readinessStub(READY),
      producer,
    );
    expect(await repo.claim('inv-1', LEASE.holder, LEASE.leaseMs)).toBe(true);

    const invoice = await processor.run('inv-1', { lease: LEASE });

    expect(invoice?.status).toBe(InvoiceStatus.AUTHORIZED);
    expect(producer.sent).toEqual([
      expect.objectContaining({ type: 'InvoiceAuthorized', invoiceId: 'inv-1', saleId: '42' }),
    ]);
    const stored = (await repo.getInvoiceById('inv-1'))!;
    expect(stored.statusHistory.map((entry) => entry.name)).toEqual([
      InvoiceStatus.PENDING,
      InvoiceStatus.CREATED,
      InvoiceStatus.SIGNED,
      InvoiceStatus.SENT,
      InvoiceStatus.AUTHORIZED,
    ]);
    expect(stored.resultPublishedAt).not.toBeNull();
    expect(await repo.claimDue('worker-2:1', 60_000, 10)).toEqual([]);

    // Taken again by mistake: nothing to do, nothing published twice
    await processor.run('inv-1', { lease: LEASE });
    expect(producer.sent).toHaveLength(1);
  });

  it('keeps the result due when Kafka fails, and publishes it on a later run', async () => {
    const now = new Date('2026-10-09T15:00:00Z');
    const repo = new InMemoryInvoiceRepository();
    const invoice = await makeAuthorizedInvoice('inv-1', makePoint(), null);
    await repo.createInvoice(invoice);
    const producer = producerStub();
    producer.sendMessage.mockRejectedValueOnce(new Error('broker down'));
    const processor = new InvoiceProcessor(
      repo,
      repo,
      new Map(),
      readinessStub(READY),
      producer,
      60_000,
      () => now,
    );

    await processor.run('inv-1');

    let stored = (await repo.getInvoiceById('inv-1'))!;
    expect(stored.resultPublishedAt).toBeNull();
    expect(stored.nextAttemptAt).toEqual(new Date(now.getTime() + 60_000));

    await processor.run('inv-1');

    stored = (await repo.getInvoiceById('inv-1'))!;
    expect(producer.sent.map((e) => e.type)).toEqual(['InvoiceAuthorized']);
    expect(stored.resultPublishedAt).toEqual(now);
    expect(stored.nextAttemptAt).toBeNull();
  });

  it('leaves the result to the worker without a producer (a manual retry in the API)', async () => {
    const repo = new InMemoryInvoiceRepository();
    await repo.createInvoice(await makeAuthorizedInvoice('inv-1', makePoint(), null));
    const processor = new InvoiceProcessor(repo, repo, new Map(), readinessStub(READY), null);

    await processor.run('inv-1', { maxSteps: 1 });

    const stored = (await repo.getInvoiceById('inv-1'))!;
    expect(stored.resultPublishedAt).toBeNull();
    expect(stored.nextAttemptAt).not.toBeNull();
  });

  it('stops once its lease is taken by another worker', async () => {
    const repo = new InMemoryInvoiceRepository();
    await storedPending(repo);
    const producer = producerStub();
    const processor = new InvoiceProcessor(
      repo,
      repo,
      sriCommands(repo),
      readinessStub(READY),
      producer,
    );
    // The lease ran out and another worker has the invoice now
    repo.locks.set('inv-1', { holder: 'worker-2:1', until: Date.now() + 60_000 });

    const invoice = await processor.run('inv-1', { lease: LEASE });

    expect(invoice?.status).toBe(InvoiceStatus.CREATED);
    expect(producer.sent).toEqual([]);
  });

  it('asks again for the issuer of an invoice released after its issuer changed', async () => {
    const repo = new InMemoryInvoiceRepository();
    const invoice = await storedPending(repo);
    invoice.recordIssue({ code: 'CERTIFICATE_NOT_SELECTED', message: 'x', at: new Date() });
    await repo.updateInvoice(invoice);
    const releasedAt = new Date();
    await repo.requeue(['inv-1'], releasedAt);
    const readiness = readinessStub(READY);
    const processor = new InvoiceProcessor(
      repo,
      repo,
      new Map([[InvoiceStatus.PENDING, prepareCommand(readiness, repo)]]),
      readiness,
      null,
    );

    await processor.run('inv-1', { maxSteps: 1 });

    expect(readiness.invalidateIfOlder).toHaveBeenCalledWith(TENANT_A, releasedAt);
    expect((await repo.getInvoiceById('inv-1'))!.status).toBe(InvoiceStatus.CREATED);
  });
});

describe('InvoiceRecoveryService', () => {
  const NOW = new Date('2026-10-09T15:00:00Z');
  const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
  let saleId = 100;

  async function store(
    repo: InMemoryInvoiceRepository,
    id: string,
    setup: (i: Invoice) => void,
    point = makePoint(),
  ) {
    // One sale per invoice: a sale has a single active invoice
    const sale = makeSale({ sale_id: ++saleId });
    const invoice = Invoice.receive(id, point, sale, minutesAgo(60));
    setup(invoice);
    expect(await repo.createInvoice(invoice)).toBe(true);
  }

  /** Invoices of every kind, waiting or due */
  async function invoicesOfEveryKind(): Promise<InMemoryInvoiceRepository> {
    const repo = new InMemoryInvoiceRepository(() => NOW);
    await store(repo, 'blocked', (i) =>
      i.recordIssue({ code: 'CERTIFICATE_EXPIRED', message: 'x', at: minutesAgo(30) }),
    );
    // Due by itself: the worker takes it, the recovery doesn't touch it
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
    // No issue: due since it was received
    await store(repo, 'moving', () => undefined);
    // No issue and no date (left by an older version): nothing would take it
    await store(repo, 'stuck', () => undefined);
    repo.records.get('stuck')!.next_attempt_at = null;
    return repo;
  }

  function recovery(
    repo: InMemoryInvoiceRepository,
    ready: boolean | Parameters<typeof readinessStub>[0],
  ) {
    const readiness = readinessStub(
      typeof ready === 'boolean' ? (ready ? READY : NOT_READY) : ready,
    );
    return new InvoiceRecoveryService(repo, readiness, () => NOW);
  }

  // Put back in the queue: due now
  const released = (repo: InMemoryInvoiceRepository) =>
    [...repo.records.values()]
      .filter((row) => row.next_attempt_at?.getTime() === NOW.getTime())
      .map((row) => row.id)
      .sort();

  it('puts back what waits for an issuer that is ready, and what nothing would take', async () => {
    const notReady = await invoicesOfEveryKind();
    expect(await recovery(notReady, false).run()).toBe(1);
    expect(released(notReady)).toEqual(['stuck']);

    const ready = await invoicesOfEveryKind();
    expect(await recovery(ready, true).run()).toBe(2);
    expect(released(ready)).toEqual(['blocked', 'stuck']);
  });

  it('puts back everything that needs attention with "retry all"', async () => {
    const repo = await invoicesOfEveryKind();

    expect(await recovery(repo, true).run({ all: true })).toBe(4);

    expect(released(repo)).toEqual(['blocked', 'invalid', 'stuck', 'transient-later']);
    // Only the dates change: a step in progress still saves over the same version
    expect(repo.records.get('blocked')!.version).toBe(1);
  });

  it('asks the issuer again instead of trusting an answer cached by this process', async () => {
    const repo = await invoicesOfEveryKind();
    const readiness = readinessStub(READY);

    await new InvoiceRecoveryService(repo, readiness, () => NOW).run();

    expect(readiness.invalidate).toHaveBeenCalledWith(TENANT_A);
  });

  it("doesn't let a company whose issuer can't invoice hold back another one", async () => {
    const repo = new InMemoryInvoiceRepository(() => NOW);
    const waiting = (i: Invoice) =>
      i.recordIssue({ code: 'CERTIFICATE_NOT_SELECTED', message: 'x', at: NOW });
    await store(repo, 'of-a', waiting);
    await store(repo, 'of-b', waiting, makePoint({ tenantId: TENANT_B, issuerRuc: RUC_B }));

    // A has no certificate; B is ready
    await recovery(repo, {
      [TENANT_A]: NOT_READY,
      [TENANT_B]: {
        config: makeConfig({ tenantId: TENANT_B, taxId: RUC_B }),
        certificate: makeCertificate({ tenantId: TENANT_B, taxIds: [RUC_B] }),
      },
    }).run();

    expect(released(repo)).toEqual(['of-b']);
  });

  it('retries a sale of another RUC only once the profile has that RUC', async () => {
    const repo = new InMemoryInvoiceRepository(() => NOW);
    await store(
      repo,
      'other-ruc',
      (i) => i.recordIssue({ code: 'ISSUER_RUC_MISMATCH', message: 'x', at: NOW }),
      makePoint({ issuerRuc: RUC_B }),
    );

    await recovery(repo, true).run({ all: true });
    expect(released(repo)).toEqual([]);

    await recovery(repo, {
      config: makeConfig({ taxId: RUC_B }),
      certificate: makeCertificate(),
    }).run();
    expect(released(repo)).toEqual(['other-ruc']);
  });

  it('puts back only the invoices of the company that changed', async () => {
    const repo = new InMemoryInvoiceRepository(() => NOW);
    const waiting = (i: Invoice) =>
      i.recordIssue({ code: 'CONFIG_MISSING', message: 'x', at: NOW });
    await store(repo, 'of-a', waiting);
    await store(repo, 'of-b', waiting, makePoint({ tenantId: TENANT_B, issuerRuc: RUC_B }));

    await recovery(repo, true).run({ tenantId: TENANT_B });

    expect(released(repo)).toEqual(['of-b']);
  });
});
