import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';

import { VoucherType } from '#/modules/company-config/domain/sequence';
import { ReceiveCreditNoteCommand } from '#/modules/invoice/app/commands/receive-credit-note';
import { toReceivedCreditNote } from '#/modules/invoice/app/handlers/credit-note-requested.handler';
import { AccessCode } from '#/modules/invoice/domain/access-code';
import { CreditNoteResultEvent } from '#/modules/invoice/domain/events';
import { Invoice, InvoiceStatus } from '#/modules/invoice/domain/invoice';
import { SaleData } from '#/modules/invoice/domain/sale';
import { toCreditNoteResultMessage } from '#/modules/invoice/infra/messaging/credit-note-message';
import { CreditNoteRequestedMessageSchema } from '#/modules/invoice/infra/messaging/schemas';

import {
  InMemoryInvoiceRepository,
  invoiceSteps,
  makeCertificate,
  makeConfig,
  makeSale,
  readinessStub,
} from '../helpers';
import { loadExamples, loadSchema } from './contracts';

const requested = loadExamples('credit_notes.requested');
const results = loadExamples('credit_notes.results');
const validateResult = new Ajv2020({ allErrors: true, strict: false }).compile(
  loadSchema('credit_notes.results'),
);
const validateRequested = new Ajv2020({ allErrors: true, strict: false }).compile(
  loadSchema('credit_notes.requested'),
);

const EXAMPLES_TENANT = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f';
const EXAMPLES_RUC = '1799999990001';
const ready = readinessStub({
  [EXAMPLES_TENANT]: {
    config: makeConfig({ tenantId: EXAMPLES_TENANT, taxId: EXAMPLES_RUC }),
    certificate: makeCertificate({ tenantId: EXAMPLES_TENANT, taxIds: [EXAMPLES_RUC] }),
  },
});

const BUYER: NonNullable<SaleData['customer']> = {
  id: 55,
  name: 'Construcciones Andinas S.A.',
  tax_id: '1790012345001',
  tax_type: 'RUC',
  email: null,
  phone: null,
  address: null,
};

/** The credit note of an example, over an invoice stored as authorized */
async function creditNoteOf(example: unknown) {
  const message = CreditNoteRequestedMessageSchema.parse(example);
  const received = toReceivedCreditNote(message);
  const repo = new InMemoryInvoiceRepository();
  const invoice = Invoice.receive(
    received.creditNote.invoice_id,
    received.point,
    makeSale({ sale_id: received.creditNote.sale_id, customer: BUYER }),
  );
  invoice.assignSequence('000000123');
  const accessCode = AccessCode.create('0510202601179999999000110010010000001231234567811');
  invoice.prepare({ accessCode, signatureId: 'cert-1', xml: '<factura/>' });
  invoice.sign('<factura firmada/>');
  invoice.markAsSent([]);
  invoice.authorize(
    { number: accessCode.value, authorizedAt: new Date(), xmlKey: 'tenants/a/invoices/x.xml' },
    [],
  );
  await repo.createInvoice(invoice);

  await new ReceiveCreditNoteCommand(repo).execute(received);
  const [stored] = await repo.findBySaleId(
    received.point.tenantId,
    String(received.creditNote.sale_id),
    VoucherType.CREDIT_NOTE,
  );
  // With the real XSD: every example has to build a credit note the SRI's schema accepts
  await invoiceSteps(repo, ready).get(InvoiceStatus.PENDING)!.execute(stored);
  return stored;
}

describe('credit_notes.requested v1 contract', () => {
  it('covers a refund, a cancelled sale and a branch without an address', () => {
    expect(Object.keys(requested).sort()).toEqual([
      'branch-without-address',
      'cancelled-sale',
      'refund',
    ]);
  });

  it.each(Object.keys(requested))('%s matches the contract', (name) => {
    expect(validateRequested(requested[name]) ? [] : validateRequested.errors).toEqual([]);
  });

  it.each(Object.keys(requested))('%s passes the zod schema and the XSD', async (name) => {
    const stored = await creditNoteOf(requested[name]);

    expect(stored.status).toBe(InvoiceStatus.CREATED);
    expect(stored.xml).toContain('<codDoc>04</codDoc>');
    expect(stored.xml).toMatch(/<numDocModificado>\d{3}-\d{3}-000000123<\/numDocModificado>/);
    expect(stored.xml).toContain('<fechaEmisionDocSustento>05/10/2026</fechaEmisionDocSustento>');
  });

  it('says where it comes from, as the message does', () => {
    const { point, creditNote } = toReceivedCreditNote(
      CreditNoteRequestedMessageSchema.parse(requested.refund),
    );

    expect(point).toEqual({
      tenantId: EXAMPLES_TENANT,
      issuerRuc: EXAMPLES_RUC,
      establishment: '001',
      emissionPoint: '002',
      establishmentAddress: 'Av. Amazonas N34-120 y Av. Atahualpa, Quito',
    });
    expect(creditNote.credit_note_id).toBe(31);
    expect(creditNote).not.toHaveProperty('issuer_ruc');
  });

  it("rejects a version it doesn't know", () => {
    const parsed = CreditNoteRequestedMessageSchema.safeParse({
      ...requested.refund,
      schema_version: 2,
    });

    expect(parsed.success).toBe(false);
  });
});

describe('credit_notes.results v1 contract', () => {
  const base = {
    tenantId: EXAMPLES_TENANT,
    documentId: '2f3a4b5c-6d7e-5f80-9a1b-2c3d4e5f6a7b',
    creditNoteId: 31,
    saleId: '1201',
    occurredAt: new Date('2026-11-02T15:04:21.512Z'),
  };
  const authorized: CreditNoteResultEvent = {
    ...base,
    type: 'CreditNoteAuthorized',
    status: InvoiceStatus.AUTHORIZED,
    number: '001-002-000000012',
    accessCode: '0211202604179999999000110010020000000121234567811',
    authorizedAt: new Date('2026-11-02T15:04:20.000Z'),
    reason: null,
  };
  const rejected: CreditNoteResultEvent = {
    ...base,
    type: 'CreditNoteRejected',
    status: InvoiceStatus.REJECTED,
    number: null,
    accessCode: null,
    authorizedAt: null,
    reason: 'No autorizado',
  };

  it.each(Object.keys(results))('%s matches the contract', (name) => {
    expect(validateResult(results[name]) ? [] : validateResult.errors).toEqual([]);
  });

  it.each([
    ['authorized', authorized],
    ['rejected without a number', rejected],
  ])('what a %s credit note publishes matches the contract', (_name, event) => {
    // As it travels: JSON
    const message = JSON.parse(JSON.stringify(toCreditNoteResultMessage(event)));

    expect(validateResult(message) ? [] : validateResult.errors).toEqual([]);
    expect(message.tenant_id).toBe(EXAMPLES_TENANT);
    expect(message.payload.sale_id).toBe(1201);
  });

  it('an authorized one needs its number, access code and date', () => {
    const message = JSON.parse(JSON.stringify(toCreditNoteResultMessage(authorized)));
    message.payload.number = null;

    expect(validateResult(message)).toBe(false);
  });

  it('a result published again is the same event', () => {
    expect(toCreditNoteResultMessage(authorized).event_id).toBe(
      toCreditNoteResultMessage(authorized).event_id,
    );
    expect(toCreditNoteResultMessage(authorized).event_id).not.toBe(
      toCreditNoteResultMessage({ ...rejected }).event_id,
    );
  });
});
