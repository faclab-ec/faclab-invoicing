import { randomUUID } from 'crypto';
import { expect, it, vi } from 'vitest';

import { PgCertificateRepository } from '#/modules/certificate/infra/persistence/pg-certificate.repository';
import { PgCompanyConfigRepository } from '#/modules/company-config/infra/persistence/pg-company-config.repository';
import { AuthorizeInvoiceCommand } from '#/modules/invoice/app/commands/authorize-invoice';
import { InvoiceCommand } from '#/modules/invoice/app/commands/command';
import { PrepareInvoiceCommand } from '#/modules/invoice/app/commands/prepare-invoice';
import { ReceiveSaleCommand } from '#/modules/invoice/app/commands/receive-sale';
import { SendInvoiceCommand } from '#/modules/invoice/app/commands/send-invoice';
import { SignInvoiceCommand } from '#/modules/invoice/app/commands/sign-invoice';
import { InvoiceEventHandler } from '#/modules/invoice/app/handlers/invoice-event.handler';
import { SaleConfirmedHandler } from '#/modules/invoice/app/handlers/sale-confirmed.handler';
import { InvoiceDomainEvent } from '#/modules/invoice/domain/events';
import { InvoiceStatus } from '#/modules/invoice/domain/invoice';
import {
  AuthorizationVoucher,
  AuthorizationVoucherStatus,
  ValidationVoucher,
  ValidationVoucherStatus,
} from '#/modules/invoice/domain/voucher';
import { PgInvoiceRepository } from '#/modules/invoice/infra/persistence/pg-invoice.repository';

import {
  makeCertificate,
  makeConfig,
  makePoint,
  makeReceivedSale,
  makeSale,
  makeSaleMessage,
  readinessStub,
  RUC_A,
  RUC_B,
  TENANT_A,
  TENANT_B,
} from '../helpers';
import { describePostgres, usePostgres } from './support';

describePostgres('Invoice flow on PostgreSQL', () => {
  const pool = usePostgres();

  it('leaves a single active invoice when resends of a sale arrive at the same time', async () => {
    const invoices = new PgInvoiceRepository(pool());
    const receive = new ReceiveSaleCommand(invoices);

    for (const saleId of [71, 72, 73]) {
      const sale = makeSale({ sale_id: saleId });
      // Different event ids: resends from faclab-core, not Kafka redeliveries
      const received = await Promise.all([
        receive.execute(makeReceivedSale(randomUUID(), sale)),
        receive.execute(makeReceivedSale(randomUUID(), sale)),
      ]);

      expect(received.filter((invoice) => invoice !== null)).toHaveLength(1);
      const stored = await invoices.findBySaleId(TENANT_A, String(saleId));
      expect(stored.filter((invoice) => invoice.isActive)).toHaveLength(1);
    }
  });

  it("takes two companies' sales, at the same time, to invoices numbered on their own", async () => {
    const invoices = new PgInvoiceRepository(pool());
    const configs = new PgCompanyConfigRepository(pool());
    const certificates = new PgCertificateRepository(pool());
    const issuers = [
      { tenantId: TENANT_A, taxId: RUC_A },
      { tenantId: TENANT_B, taxId: RUC_B },
    ];
    const ready: Parameters<typeof readinessStub>[0] = {};
    for (const { tenantId, taxId } of issuers) {
      const certificate = makeCertificate({ id: randomUUID(), tenantId, taxIds: [taxId] });
      await certificates.save(certificate);
      await configs.save(makeConfig({ tenantId, taxId, signingCertId: certificate.id }));
      ready[tenantId] = { config: (await configs.find(tenantId))!, certificate };
    }
    const readiness = readinessStub(ready);

    const published: InvoiceDomainEvent[] = [];
    const producer = {
      sendMessage: vi.fn(async (event: InvoiceDomainEvent) => void published.push(event)),
    };
    // The SRI, simulated: receives and authorizes
    const commands = new Map<InvoiceStatus, InvoiceCommand>([
      [InvoiceStatus.PENDING, new PrepareInvoiceCommand(readiness, invoices)],
      [
        InvoiceStatus.CREATED,
        new SignInvoiceCommand({ signInvoice: async (xml) => `${xml}<!-- signed -->` }, invoices),
      ],
      [
        InvoiceStatus.SIGNED,
        new SendInvoiceCommand(
          {
            validateXml: async () =>
              new ValidationVoucher(ValidationVoucherStatus.ACCEPTED, null, ['RECIBIDA']),
          },
          invoices,
        ),
      ],
      [
        InvoiceStatus.SENT,
        new AuthorizeInvoiceCommand(
          {
            authorizeXml: async (code) =>
              new AuthorizationVoucher(AuthorizationVoucherStatus.AUTHORIZED, code, new Date(), [
                'AUTORIZADO',
              ]),
          },
          invoices,
        ),
      ],
    ]);
    const invoiceHandler = new InvoiceEventHandler(invoices, commands, producer);
    const saleHandler = new SaleConfirmedHandler(new ReceiveSaleCommand(invoices), producer);

    // The same sale id in both companies, received at once
    await Promise.all(
      issuers.map(({ tenantId, taxId }) =>
        saleHandler.handle(
          makeSaleMessage(randomUUID(), makeSale(), makePoint({ tenantId, issuerRuc: taxId })),
        ),
      ),
    );
    // Each event goes back through the `invoices` topic and moves its invoice one step
    for (let next = 0; next < published.length; next++) {
      await invoiceHandler.handle(published[next]);
    }

    const types = published.filter((event) => event.tenantId === TENANT_A).map((e) => e.type);
    expect(types).toEqual([
      'InvoiceReceived',
      'InvoiceCreated',
      'InvoiceSigned',
      'InvoiceSent',
      'InvoiceAuthorized',
    ]);
    const [ofB] = await invoices.findBySaleId(TENANT_B, '42');
    expect(ofB.status).toBe(InvoiceStatus.AUTHORIZED);
    expect(ofB.sequence).toBe('000000001');
    expect(ofB.xml).toContain(`<ruc>${RUC_B}</ruc>`);
    const [invoice] = await invoices.findBySaleId(TENANT_A, '42');
    expect(invoice.status).toBe(InvoiceStatus.AUTHORIZED);
    expect(invoice.sequence).toBe('000000001');
    expect(invoice.xml).toContain(`<ruc>${RUC_A}</ruc>`);
    expect(invoice.xml).toContain('<secuencial>000000001</secuencial>');
    expect(invoice.xml).toContain('<!-- signed -->');
    expect(invoice.issue).toBeNull();

    const { rows } = await pool().query(
      'SELECT status, description FROM invoice_events WHERE invoice_id = $1 ORDER BY position',
      [invoice.id],
    );
    expect(rows).toEqual([
      { status: 'pending', description: 'Sale received' },
      { status: 'created', description: 'XML created' },
      { status: 'signed', description: 'XML signed' },
      { status: 'sent', description: 'RECIBIDA' },
      { status: 'authorized', description: 'AUTORIZADO' },
    ]);
    const counters = await pool().query(
      'SELECT tenant_id, last_value FROM sequences ORDER BY tenant_id',
    );
    expect(counters.rows).toEqual(
      [
        { tenant_id: TENANT_A, last_value: '1' },
        { tenant_id: TENANT_B, last_value: '1' },
      ].sort((a, b) => a.tenant_id.localeCompare(b.tenant_id)),
    );
  });
});
