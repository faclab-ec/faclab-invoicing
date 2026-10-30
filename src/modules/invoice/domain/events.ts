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
