export enum InvoiceStatus {
  // Sale received; waits here until the issuer can build its XML
  PENDING = 'pending',
  CREATED = 'created',
  SIGNED = 'signed',
  SENT = 'sent',
  AUTHORIZED = 'authorized',
  REJECTED = 'rejected',
}

interface BaseResultEvent {
  // The company of the invoice: travels as the `faclab-tenant-id` header, not in the body
  tenantId: string;
  invoiceId: string;
  saleId: string;
  status: InvoiceStatus;
  occurredAt: Date;
}

export interface InvoiceAuthorized extends BaseResultEvent {
  type: 'InvoiceAuthorized';
}

export interface InvoiceRejected extends BaseResultEvent {
  type: 'InvoiceRejected';
  // The SRI's messages, joined with ' >> '; faclab-core shows them in the sale
  reason: string | null;
}

/**
 * What faclab-core learns from an invoice, on the `invoices` topic: the SRI's answer. The steps in
 * between go through the queue in the database, not through Kafka (S4.2); v1 still lists their
 * event types, which nothing publishes anymore.
 */
export type InvoiceResultEvent = InvoiceAuthorized | InvoiceRejected;

interface BaseCreditNoteEvent {
  tenantId: string;
  documentId: string;
  // The id faclab-core gave the credit note
  creditNoteId: number;
  saleId: string;
  status: InvoiceStatus;
  occurredAt: Date;
}

export interface CreditNoteAuthorized extends BaseCreditNoteEvent {
  type: 'CreditNoteAuthorized';
  number: string;
  accessCode: string;
  authorizedAt: Date;
  reason: null;
}

export interface CreditNoteRejected extends BaseCreditNoteEvent {
  type: 'CreditNoteRejected';
  // Null when it was rejected before getting a number or building its XML
  number: string | null;
  accessCode: string | null;
  authorizedAt: null;
  reason: string | null;
}

/** What faclab-core learns from a credit note, on the `credit_notes.results` topic */
export type CreditNoteResultEvent = CreditNoteAuthorized | CreditNoteRejected;

/** The SRI's answer about any document */
export type VoucherResultEvent = InvoiceResultEvent | CreditNoteResultEvent;

export function isCreditNoteResult(event: VoucherResultEvent): event is CreditNoteResultEvent {
  return event.type === 'CreditNoteAuthorized' || event.type === 'CreditNoteRejected';
}
