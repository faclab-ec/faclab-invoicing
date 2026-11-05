import { describe, expect, it, vi } from 'vitest';

import { VoucherType } from '#/modules/company-config/domain/sequence';
import { InvoiceCommand } from '#/modules/invoice/app/commands/command';
import { ReceiveCreditNoteCommand } from '#/modules/invoice/app/commands/receive-credit-note';
import { ReceiveSaleCommand } from '#/modules/invoice/app/commands/receive-sale';
import { CreditNoteRequestedHandler } from '#/modules/invoice/app/handlers/credit-note-requested.handler';
import { InvoiceProcessor } from '#/modules/invoice/app/services/invoice-processor';
import { VoucherResultEvent } from '#/modules/invoice/domain/events';
import { Invoice, InvoiceStatus } from '#/modules/invoice/domain/invoice';
import { SaleData } from '#/modules/invoice/domain/sale';
import { AuthorizationVoucher, AuthorizationVoucherStatus } from '#/modules/invoice/domain/voucher';
import { CreditNoteRequestedMessage } from '#/modules/invoice/infra/messaging/schemas';

import {
  accessCodeOf,
  InMemoryDocumentStorage,
  InMemoryInvoiceRepository,
  invoiceSteps,
  makeCertificate,
  makeConfig,
  makeCreditNoteMessage,
  makePoint,
  makeReceivedSale,
  makeSale,
  readinessStub,
  simulatedSri,
  TENANT_A,
  TENANT_B,
} from '../helpers';

const BUYER: NonNullable<SaleData['customer']> = {
  id: 9,
  name: 'Construcciones Andinas Cía. Ltda.',
  tax_id: '1790012345001',
  tax_type: 'RUC',
  email: 'compras@andinas.ec',
  phone: null,
  address: null,
};

const READY = readinessStub({ config: makeConfig(), certificate: makeCertificate() });
const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_EVENT = '22222222-2222-4222-8222-222222222222';

function setup(sri: Parameters<typeof invoiceSteps>[2] = {}) {
  const repo = new InMemoryInvoiceRepository();
  const storage = new InMemoryDocumentStorage();
  const published: VoucherResultEvent[] = [];
  const commands: Map<InvoiceStatus, InvoiceCommand> = invoiceSteps(repo, READY, {
    storage,
    ...sri,
  });
  const processor = new InvoiceProcessor(repo, repo, commands, READY, {
    sendMessage: vi.fn(async (event: VoucherResultEvent) => void published.push(event)),
  });
  const handler = new CreditNoteRequestedHandler(new ReceiveCreditNoteCommand(repo));

  /** The invoice of the sale, authorized, as the worker leaves it */
  async function authorizedInvoice(customer: SaleData['customer'] = BUYER) {
    const invoice = (await new ReceiveSaleCommand(repo).execute(
      makeReceivedSale('33333333-3333-4333-8333-333333333333', makeSale({ customer })),
    ))!;
    await processor.run(invoice.id);
    published.length = 0;
    return (await repo.getInvoiceById(invoice.id))!;
  }

  async function request(
    invoiceId: string,
    overrides: Partial<CreditNoteRequestedMessage['payload']> = {},
    eventId = EVENT_ID,
  ) {
    await handler.handle(makeCreditNoteMessage({ invoice_id: invoiceId, ...overrides }, eventId));
  }

  async function creditNotes() {
    return repo.findBySaleId(TENANT_A, '42', VoucherType.CREDIT_NOTE);
  }

  return { repo, storage, published, processor, authorizedInvoice, request, creditNotes };
}

describe('A credit note, end to end against the simulated SRI', () => {
  it('goes through the same steps as an invoice and tells faclab-core the result', async () => {
    const { processor, authorizedInvoice, request, creditNotes, published } = setup();
    const invoice = await authorizedInvoice();

    await request(invoice.id);
    const [stored] = await creditNotes();
    expect(stored).toMatchObject({ docType: VoucherType.CREDIT_NOTE, saleId: '42' });
    expect(stored.status).toBe(InvoiceStatus.PENDING);

    const done = (await processor.run(stored.id))!;

    expect(done.statusHistory.map((entry) => entry.name)).toEqual([
      InvoiceStatus.PENDING,
      InvoiceStatus.CREATED,
      InvoiceStatus.SIGNED,
      InvoiceStatus.SENT,
      InvoiceStatus.AUTHORIZED,
    ]);
    expect(published).toEqual([
      expect.objectContaining({
        type: 'CreditNoteAuthorized',
        creditNoteId: 31,
        documentId: stored.id,
        saleId: '42',
        number: '001-001-000000001',
        accessCode: done.accessCode!.value,
      }),
    ]);
  });

  it('builds an XML that refers to the invoice, for its buyer, with codDoc 04 in the code', async () => {
    const { processor, authorizedInvoice, request, creditNotes } = setup();
    const invoice = await authorizedInvoice();

    await request(invoice.id);
    const [stored] = await creditNotes();
    const done = (await processor.run(stored.id))!;
    const xml = done.xml!;

    expect(accessCodeOf(xml)).toBe(done.accessCode!.value);
    // Date, then the type: the two digits after ddmmaaaa
    expect(done.accessCode!.value.slice(8, 10)).toBe('04');
    expect(invoice.accessCode!.value.slice(8, 10)).toBe('01');
    expect(xml).toContain(`<numDocModificado>${invoice.number}</numDocModificado>`);
    expect(xml).toContain(
      `<fechaEmisionDocSustento>${invoice.accessCode!.emissionDate}</fechaEmisionDocSustento>`,
    );
    expect(xml).toContain('<identificacionComprador>1790012345001</identificacionComprador>');
    expect(xml).toContain('<motivo>Producto con defecto de fábrica</motivo>');
  });

  it('numbers apart from the invoices of the same emission point', async () => {
    const { repo, processor, authorizedInvoice, request, creditNotes } = setup();
    const invoice = await authorizedInvoice();
    expect(invoice.sequence).toBe('000000001');

    await request(invoice.id);
    const [first] = await creditNotes();
    expect((await processor.run(first.id))!.sequence).toBe('000000001');

    await request(invoice.id, { credit_note_id: 32 }, SECOND_EVENT);
    const [, second] = await creditNotes();
    expect((await processor.run(second.id))!.sequence).toBe('000000002');

    // A new invoice of that emission point goes on with its own numbering
    const next = (await new ReceiveSaleCommand(repo).execute(
      makeReceivedSale('44444444-4444-4444-8444-444444444444', makeSale({ sale_id: 43 })),
    ))!;
    expect((await processor.run(next.id))!.sequence).toBe('000000002');
  });

  it('is issued from the emission point the message says, not the invoice its', async () => {
    const { processor, authorizedInvoice, request, creditNotes } = setup();
    const invoice = await authorizedInvoice();

    await request(invoice.id, { emission_point_code: '002' });
    const [stored] = await creditNotes();
    const done = (await processor.run(stored.id))!;

    expect(done.number).toBe('001-002-000000001');
    expect(done.xml).toContain('<ptoEmi>002</ptoEmi>');
    expect(done.xml).toContain('<numDocModificado>001-001-000000001</numDocModificado>');
  });

  it("doesn't stop a resend of the sale: only invoices count there", async () => {
    const { repo, authorizedInvoice, request, processor, published } = setup();
    const invoice = await authorizedInvoice();
    await request(invoice.id);

    await new ReceiveSaleCommand(repo).execute(
      makeReceivedSale('55555555-5555-4555-8555-555555555555', makeSale({ customer: BUYER })),
    );

    // The invoice's result is published again, not ignored because of its credit note
    const again = (await repo.getInvoiceById(invoice.id))!;
    expect(again.resultPublishedAt).toBeNull();
    await processor.run(invoice.id);
    expect(published.map((event) => event.type)).toEqual(['InvoiceAuthorized']);
  });
});

describe('A credit note the invoice does not admit is rejected without a number', () => {
  async function rejectionOf(setUp: ReturnType<typeof setup>, invoiceId: string) {
    await setUp.request(invoiceId);
    const [stored] = await setUp.creditNotes();
    const done = (await setUp.processor.run(stored.id))!;
    expect(done.status).toBe(InvoiceStatus.REJECTED);
    expect(done.sequence).toBeNull();
    expect(done.accessCode).toBeNull();
    const [event] = setUp.published;
    expect(event).toMatchObject({
      type: 'CreditNoteRejected',
      creditNoteId: 31,
      number: null,
      accessCode: null,
      authorizedAt: null,
    });
    return event as { reason: string };
  }

  it('an invoice to the final consumer (NAC-DGERCGC25-00000014, art. 3)', async () => {
    const setUp = setup();
    const invoice = await setUp.authorizedInvoice(null);

    const { reason } = await rejectionOf(setUp, invoice.id);

    expect(reason).toContain('final consumer');
    expect(reason).toContain('NAC-DGERCGC25-00000014');
  });

  it('a customer with the identification of the final consumer', async () => {
    const setUp = setup();
    const invoice = await setUp.authorizedInvoice({ ...BUYER, tax_id: '9999999999999' });

    const { reason } = await rejectionOf(setUp, invoice.id);

    expect(reason).toContain('final consumer');
  });

  it('an invoice that does not exist', async () => {
    const setUp = setup();

    const { reason } = await rejectionOf(setUp, 'bf7d9d5e-0a0e-4d62-9b9a-7a0d2a7b3f10');

    expect(reason).toContain("doesn't exist");
  });

  it('an invoice of another company', async () => {
    const setUp = setup();
    const other = Invoice.receive(
      'inv-of-b',
      makePoint({ tenantId: TENANT_B }),
      makeSale({ customer: BUYER }),
    );
    await setUp.repo.createInvoice(other);

    const { reason } = await rejectionOf(setUp, other.id);

    expect(reason).toContain("doesn't exist");
  });

  it('an invoice the SRI has not authorized', async () => {
    const setUp = setup();
    const invoice = (await new ReceiveSaleCommand(setUp.repo).execute(
      makeReceivedSale('66666666-6666-4666-8666-666666666666', makeSale({ customer: BUYER })),
    ))!;

    const { reason } = await rejectionOf(setUp, invoice.id);

    expect(reason).toContain('not authorized');
  });

  it('another credit note', async () => {
    const setUp = setup();
    const invoice = await setUp.authorizedInvoice();
    await setUp.request(invoice.id, { credit_note_id: 30 }, SECOND_EVENT);
    const [first] = await setUp.creditNotes();
    await setUp.processor.run(first.id);
    setUp.published.length = 0;

    await setUp.request(first.id);
    const stored = (await setUp.creditNotes())[1];
    const done = (await setUp.processor.run(stored.id))!;

    expect(done.status).toBe(InvoiceStatus.REJECTED);
    expect(setUp.published[0]).toMatchObject({ type: 'CreditNoteRejected' });
    expect((setUp.published[0] as { reason: string }).reason).toContain('not an invoice');
  });
});

describe('Receiving the same credit note again', () => {
  it('ignores a repeated delivery of the same message', async () => {
    const { authorizedInvoice, request, creditNotes } = setup();
    const invoice = await authorizedInvoice();

    await request(invoice.id);
    await request(invoice.id);

    expect(await creditNotes()).toHaveLength(1);
  });

  it('ignores asking again while it is in progress', async () => {
    const { authorizedInvoice, request, creditNotes } = setup();
    const invoice = await authorizedInvoice();

    await request(invoice.id);
    await request(invoice.id, {}, SECOND_EVENT);

    expect(await creditNotes()).toHaveLength(1);
  });

  it('publishes the result again when it is authorized: faclab-core may have lost it', async () => {
    const { processor, authorizedInvoice, request, creditNotes, published } = setup();
    const invoice = await authorizedInvoice();
    await request(invoice.id);
    const [stored] = await creditNotes();
    await processor.run(stored.id);
    expect(published).toHaveLength(1);

    await request(invoice.id, {}, SECOND_EVENT);
    await processor.run(stored.id);

    expect(await creditNotes()).toHaveLength(1);
    expect(published.map((event) => event.type)).toEqual([
      'CreditNoteAuthorized',
      'CreditNoteAuthorized',
    ]);
  });

  it('creates another document, with another number, after a rejection', async () => {
    let rejected = true;
    const { processor, authorizedInvoice, request, creditNotes, published } = setup({
      sri: {
        authorizeXml: async (code, environment) =>
          rejected
            ? new AuthorizationVoucher(AuthorizationVoucherStatus.REJECTED, code, null, [
                'ERROR 68: Documento sustento',
              ])
            : simulatedSri.authorizeXml(code, environment),
      },
    });
    rejected = false;
    const invoice = await authorizedInvoice();
    rejected = true;

    await request(invoice.id);
    const [first] = await creditNotes();
    await processor.run(first.id);
    expect(published[0]).toMatchObject({
      type: 'CreditNoteRejected',
      number: '001-001-000000001',
      reason: 'ERROR 68: Documento sustento',
    });

    rejected = false;
    await request(invoice.id, {}, SECOND_EVENT);
    const [, second] = await creditNotes();
    const done = (await processor.run(second.id))!;

    expect(done.status).toBe(InvoiceStatus.AUTHORIZED);
    expect(done.sequence).toBe('000000002');
    expect(published[1]).toMatchObject({ type: 'CreditNoteAuthorized', creditNoteId: 31 });
  });
});

describe("A credit note whose amounts don't add up", () => {
  it('stays with an issue that is only retried by hand', async () => {
    const { processor, authorizedInvoice, request, creditNotes, published } = setup();
    const invoice = await authorizedInvoice();

    await request(invoice.id, { total: '11.51' });
    const [stored] = await creditNotes();
    const after = (await processor.run(stored.id))!;

    expect(after.status).toBe(InvoiceStatus.PENDING);
    expect(after.issue?.code).toBe('INVOICE_DATA_INVALID');
    expect(after.nextAttemptAt).toBeNull();
    expect(after.sequence).toBeNull();
    expect(published).toEqual([]);
  });
});

describe('The delivery of an authorized credit note', () => {
  it("goes to the invoice's buyer, without touching a final consumer's", async () => {
    const { repo, processor, authorizedInvoice, request, creditNotes } = setup();
    const invoice = await authorizedInvoice();
    await request(invoice.id);
    const [stored] = await creditNotes();

    await processor.run(stored.id);

    const deliveries = await repo.deliveries.findByInvoice(TENANT_A, stored.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ kind: 'authorization', recipient: 'compras@andinas.ec' });
  });

  it('keeps its authorized XML under its own access code', async () => {
    const { storage, processor, authorizedInvoice, request, creditNotes } = setup();
    const invoice = await authorizedInvoice();
    await request(invoice.id);
    const [stored] = await creditNotes();

    const done = (await processor.run(stored.id))!;

    expect(done.authorization?.xmlKey).toContain(done.accessCode!.value);
    expect(storage.objects.has(done.authorization!.xmlKey)).toBe(true);
    expect(done.accessCode!.value).not.toBe(invoice.accessCode!.value);
  });
});
