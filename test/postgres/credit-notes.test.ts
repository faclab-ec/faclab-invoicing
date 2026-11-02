import { randomUUID } from 'crypto';
import { expect, it, vi } from 'vitest';

import { PgCertificateRepository } from '#/modules/certificate/infra/persistence/pg-certificate.repository';
import { VoucherType } from '#/modules/company-config/domain/sequence';
import { PgCompanyConfigRepository } from '#/modules/company-config/infra/persistence/pg-company-config.repository';
import { ReceiveCreditNoteCommand } from '#/modules/invoice/app/commands/receive-credit-note';
import { ReceiveSaleCommand } from '#/modules/invoice/app/commands/receive-sale';
import { CreditNoteRequestedHandler } from '#/modules/invoice/app/handlers/credit-note-requested.handler';
import { InvoiceProcessor } from '#/modules/invoice/app/services/invoice-processor';
import { VoucherResultEvent } from '#/modules/invoice/domain/events';
import { InvoiceStatus } from '#/modules/invoice/domain/invoice';
import { SaleData } from '#/modules/invoice/domain/sale';
import { PgInvoiceRepository } from '#/modules/invoice/infra/persistence/pg-invoice.repository';
import { PgInvoiceQueue } from '#/modules/invoice/infra/persistence/pg-invoice-queue';

import {
  InMemoryDocumentStorage,
  invoiceSteps,
  makeCertificate,
  makeConfig,
  makeCreditNoteMessage,
  makeReceivedSale,
  makeSale,
  readinessStub,
  TENANT_A,
} from '../helpers';
import { describePostgres, usePostgres } from './support';

const BUYER: NonNullable<SaleData['customer']> = {
  id: 9,
  name: 'Construcciones Andinas Cía. Ltda.',
  tax_id: '1790012345001',
  tax_type: 'RUC',
  email: 'compras@andinas.ec',
  phone: null,
  address: null,
};

describePostgres('Credit notes on PostgreSQL', () => {
  const pool = usePostgres();

  async function setup() {
    const invoices = new PgInvoiceRepository(pool());
    // Stored: invoices.signature_id points at the company's certificate
    const certificate = makeCertificate({ id: randomUUID() });
    await new PgCertificateRepository(pool()).save(certificate);
    const configs = new PgCompanyConfigRepository(pool());
    await configs.save(makeConfig({ signingCertId: certificate.id }));
    const readiness = readinessStub({
      config: (await configs.find(TENANT_A))!,
      certificate,
    });
    const published: VoucherResultEvent[] = [];
    const processor = new InvoiceProcessor(
      invoices,
      new PgInvoiceQueue(pool()),
      invoiceSteps(invoices, readiness, { storage: new InMemoryDocumentStorage() }),
      readiness,
      { sendMessage: vi.fn(async (event: VoucherResultEvent) => void published.push(event)) },
    );
    const handler = new CreditNoteRequestedHandler(new ReceiveCreditNoteCommand(invoices));
    const authorizedInvoice = async (saleId = 42) => {
      const invoice = (await new ReceiveSaleCommand(invoices).execute(
        makeReceivedSale(randomUUID(), makeSale({ sale_id: saleId, customer: BUYER })),
      ))!;
      await processor.run(invoice.id);
      published.length = 0;
      return (await invoices.getInvoiceById(invoice.id))!;
    };
    return { invoices, processor, handler, published, authorizedInvoice };
  }

  it('numbers invoices and credit notes apart in the same emission point', async () => {
    const { invoices, processor, handler, authorizedInvoice } = await setup();
    const invoice = await authorizedInvoice();
    expect(invoice.sequence).toBe('000000001');

    await handler.handle(makeCreditNoteMessage({ invoice_id: invoice.id }, randomUUID()));
    const [stored] = await invoices.findBySaleId(TENANT_A, '42', VoucherType.CREDIT_NOTE);
    const done = (await processor.run(stored.id))!;

    // The same number, in one company, establishment and emission point: uq_invoices_tenant_number
    // doesn't get in the way
    expect(done.status).toBe(InvoiceStatus.AUTHORIZED);
    expect(done.sequence).toBe('000000001');
    const counters = await pool().query(
      `SELECT doc_type, last_value FROM sequences ORDER BY doc_type`,
    );
    expect(counters.rows).toEqual([
      { doc_type: '01', last_value: '1' },
      { doc_type: '04', last_value: '1' },
    ]);
  });

  it('keeps a credit note although the sale has an active invoice', async () => {
    const { invoices, handler, authorizedInvoice } = await setup();
    const invoice = await authorizedInvoice();

    await handler.handle(makeCreditNoteMessage({ invoice_id: invoice.id }, randomUUID()));

    expect(await invoices.findBySaleId(TENANT_A, '42', VoucherType.INVOICE)).toHaveLength(1);
    expect(await invoices.findBySaleId(TENANT_A, '42', VoucherType.CREDIT_NOTE)).toHaveLength(1);
    expect(await invoices.findBySaleId(TENANT_A, '42')).toHaveLength(2);
  });

  it('leaves a single active document when a credit note is asked twice at the same time', async () => {
    const { invoices, handler, authorizedInvoice } = await setup();
    const invoice = await authorizedInvoice();

    await Promise.all([
      handler.handle(makeCreditNoteMessage({ invoice_id: invoice.id }, randomUUID())),
      handler.handle(makeCreditNoteMessage({ invoice_id: invoice.id }, randomUUID())),
    ]);

    const stored = await invoices.findBySaleId(TENANT_A, '42', VoucherType.CREDIT_NOTE);
    expect(stored).toHaveLength(1);
    expect(await invoices.findActiveCreditNote(TENANT_A, 31)).not.toBeNull();
    expect(await invoices.findActiveCreditNote(TENANT_A, 99)).toBeNull();
  });

  it('allows several credit notes of an invoice: one per refund', async () => {
    const { invoices, processor, handler, authorizedInvoice } = await setup();
    const invoice = await authorizedInvoice();

    for (const creditNoteId of [31, 32]) {
      await handler.handle(
        makeCreditNoteMessage(
          { invoice_id: invoice.id, credit_note_id: creditNoteId },
          randomUUID(),
        ),
      );
    }
    const stored = await invoices.findBySaleId(TENANT_A, '42', VoucherType.CREDIT_NOTE);
    const numbers = [];
    for (const document of stored) numbers.push((await processor.run(document.id))!.sequence);

    expect(numbers.sort()).toEqual(['000000001', '000000002']);
  });

  it('points at the invoice it modifies, and at nothing when that invoice is unknown', async () => {
    const { invoices, processor, handler, published, authorizedInvoice } = await setup();
    const invoice = await authorizedInvoice();
    await handler.handle(makeCreditNoteMessage({ invoice_id: invoice.id }, randomUUID()));
    await handler.handle(
      makeCreditNoteMessage(
        { invoice_id: randomUUID(), credit_note_id: 40, sale_id: 77 },
        randomUUID(),
      ),
    );

    const rows = await pool().query(
      `SELECT request_id, source_invoice_id, doc_type FROM invoices
       WHERE doc_type = '04' ORDER BY request_id`,
    );
    expect(rows.rows).toEqual([
      { request_id: 31, source_invoice_id: invoice.id, doc_type: '04' },
      { request_id: 40, source_invoice_id: null, doc_type: '04' },
    ]);

    const [unknown] = await invoices.findBySaleId(TENANT_A, '77', VoucherType.CREDIT_NOTE);
    const done = (await processor.run(unknown.id))!;
    expect(done.status).toBe(InvoiceStatus.REJECTED);
    expect(published[0]).toMatchObject({ type: 'CreditNoteRejected', creditNoteId: 40 });
  });

  it('lists by document type', async () => {
    const { invoices, handler, authorizedInvoice } = await setup();
    const invoice = await authorizedInvoice();
    await handler.handle(makeCreditNoteMessage({ invoice_id: invoice.id }, randomUUID()));

    const page = await invoices.findPage(
      TENANT_A,
      { docType: VoucherType.CREDIT_NOTE },
      { limit: 10, offset: 0 },
    );

    expect(page.total).toBe(1);
    expect(page.items[0].docType).toBe(VoucherType.CREDIT_NOTE);
    expect(page.items[0].creditNote?.modified?.number).toBe('001-001-000000001');
  });
});
