import { Invoice } from './invoice';

/** Someone else saved the invoice after it was read: the change was not applied */
export class ConcurrentUpdateError extends Error {
  constructor(invoiceId: string) {
    super(`Invoice ${invoiceId} was modified concurrently`);
    this.name = 'ConcurrentUpdateError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface InvoiceRepository {
  /** False when an invoice with the same id already exists */
  createInvoice(invoice: Invoice): Promise<boolean>;
  /** Throws ConcurrentUpdateError if the stored version changed since it was read */
  updateInvoice(invoice: Invoice): Promise<Invoice>;
  getInvoiceById(id: string): Promise<Invoice | null>;
  findAll(): Promise<Invoice[]>;
  findBySaleId(saleId: string): Promise<Invoice[]>;
  /** Invoices not yet authorized or rejected */
  findInFlight(): Promise<Invoice[]>;
}
