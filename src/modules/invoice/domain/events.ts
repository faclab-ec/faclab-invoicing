export enum InvoiceStatus {
  // Sale received; waits here until the issuer can build its XML
  PENDING = 'pending',
  CREATED = 'created',
  SIGNED = 'signed',
  SENT = 'sent',
  AUTHORIZED = 'authorized',
  REJECTED = 'rejected',
}

interface BaseInvoiceEvent {
  // The company of the invoice: travels as the `faclab-tenant-id` header, not in the body
  tenantId: string;
  invoiceId: string;
  saleId: string;
  status: InvoiceStatus;
  occurredAt: Date;
}

export interface InvoiceReceived extends BaseInvoiceEvent {
  type: 'InvoiceReceived';
}

export interface InvoiceCreated extends BaseInvoiceEvent {
  type: 'InvoiceCreated';
}

export interface InvoiceSigned extends BaseInvoiceEvent {
  type: 'InvoiceSigned';
}

export interface InvoiceSent extends BaseInvoiceEvent {
  type: 'InvoiceSent';
}

export interface InvoiceAuthorized extends BaseInvoiceEvent {
  type: 'InvoiceAuthorized';
}

export interface InvoiceRejected extends BaseInvoiceEvent {
  type: 'InvoiceRejected';
}

export type InvoiceDomainEvent =
  | InvoiceReceived
  | InvoiceCreated
  | InvoiceSigned
  | InvoiceSent
  | InvoiceAuthorized
  | InvoiceRejected;

export const STATUS_EVENT_TYPE: Record<InvoiceStatus, InvoiceDomainEvent['type']> = {
  [InvoiceStatus.PENDING]: 'InvoiceReceived',
  [InvoiceStatus.CREATED]: 'InvoiceCreated',
  [InvoiceStatus.SIGNED]: 'InvoiceSigned',
  [InvoiceStatus.SENT]: 'InvoiceSent',
  [InvoiceStatus.AUTHORIZED]: 'InvoiceAuthorized',
  [InvoiceStatus.REJECTED]: 'InvoiceRejected',
};
