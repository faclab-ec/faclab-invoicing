import { Invoice, InvoiceStatus } from './invoice';

/** Someone else saved the invoice after it was read: the change was not applied */
export class ConcurrentUpdateError extends Error {
  constructor(invoiceId: string) {
    super(`Invoice ${invoiceId} was modified concurrently`);
    this.name = 'ConcurrentUpdateError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface InvoiceFilter {
  status?: InvoiceStatus;
  // Created at or after `createdFrom` and before `createdBefore`
  createdFrom?: Date;
  createdBefore?: Date;
  // Only unfinished invoices that are stuck or waiting to start, most recently updated first
  attention?: boolean;
}

export interface PageRequest {
  limit: number;
  offset: number;
}

export interface InvoicePage {
  items: Invoice[];
  // Invoices that match the filter, in all pages
  total: number;
}

export interface InvoiceRepository {
  /** False when an invoice with the same id exists or the sale already has an active one */
  createInvoice(invoice: Invoice): Promise<boolean>;
  /** Throws ConcurrentUpdateError if the stored version changed since it was read */
  updateInvoice(invoice: Invoice): Promise<Invoice>;
  getInvoiceById(id: string): Promise<Invoice | null>;
  /** One page of the matching invoices, latest first (`attention`: latest change first) */
  findPage(filter: InvoiceFilter, page: PageRequest): Promise<InvoicePage>;
  findBySaleId(saleId: string): Promise<Invoice[]>;
  /** Invoices not yet authorized or rejected */
  findInFlight(): Promise<Invoice[]>;
}
