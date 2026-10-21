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

import { makeCertificate, makeConfig, makeSale, makeSaleMessage, readinessStub } from '../helpers';
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
        receive.execute(makeSaleMessage(randomUUID(), sale)),
        receive.execute(makeSaleMessage(randomUUID(), sale)),
      ]);

      expect(received.filter((invoice) => invoice !== null)).toHaveLength(1);
      const stored = await invoices.findBySaleId(String(saleId));
      expect(stored.filter((invoice) => invoice.isActive)).toHaveLength(1);
    }
  });

  it('takes a confirmed sale to an authorized invoice numbered 000000001', async () => {
    const invoices = new PgInvoiceRepository(pool());
    const configs = new PgCompanyConfigRepository(pool());
    const certificates = new PgCertificateRepository(pool());
    const certificate = makeCertificate({ id: randomUUID() });
    await certificates.save(certificate);
    await configs.save(makeConfig({ signingCertId: certificate.id }));
    const readiness = readinessStub({ config: (await configs.find())!, certificate });

    const published: InvoiceDomainEvent[] = [];
    const producer = {
      sendMessage: vi.fn(async (event: InvoiceDomainEvent) => void published.push(event)),
    };
    // The SRI, simulated: receives and authorizes
    const commands = new Map<InvoiceStatus, InvoiceCommand>([
      [InvoiceStatus.PENDING, new PrepareInvoiceCommand(readiness, configs, invoices)],
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

    await saleHandler.handle(makeSaleMessage(randomUUID()));
    // Each event goes back through the `invoices` topic and moves the invoice one step
    for (let next = 0; next < published.length; next++) {
      await invoiceHandler.handle(published[next]);
    }

    expect(published.map((event) => event.type)).toEqual([
      'InvoiceReceived',
      'InvoiceCreated',
      'InvoiceSigned',
      'InvoiceSent',
      'InvoiceAuthorized',
    ]);
    const [invoice] = await invoices.findBySaleId('42');
    expect(invoice.status).toBe(InvoiceStatus.AUTHORIZED);
    expect(invoice.sequence).toBe('000000001');
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
    expect((await configs.find())!.invoiceSequence).toBe(2);
  });
});
