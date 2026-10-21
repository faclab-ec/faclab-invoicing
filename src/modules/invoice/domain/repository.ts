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

// Invoices of a company not yet authorized or rejected
export interface InFlightCounts {
  total: number;
  // Whose last attempt failed
  withIssues: number;
  // Stuck on a problem or still waiting to start (Invoice.needsAttention)
  needingAttention: number;
}

/**
 * The API reads through the methods that take a `tenantId`: an invoice of another company is not
 * found. The pipeline (Kafka, recovery) moves invoices of every company by id.
 */
export interface InvoiceRepository {
  /** False when an invoice with the same id exists or the sale already has an active one */
  createInvoice(invoice: Invoice): Promise<boolean>;
  /** Throws ConcurrentUpdateError if the stored version changed since it was read */
  updateInvoice(invoice: Invoice): Promise<Invoice>;
  /**
   * Takes the next number of the invoice's company, establishment and emission point and saves it
   * on the invoice, in one transaction: if the invoice changed meanwhile (ConcurrentUpdateError)
   * the number is given back.
   */
  assignSequence(invoice: Invoice): Promise<Invoice>;

  // Pipeline: any company
  getInvoiceById(id: string): Promise<Invoice | null>;
  /** Invoices not yet authorized or rejected, oldest first */
  findInFlight(): Promise<Invoice[]>;

  // API: one company
  findForTenant(tenantId: string, id: string): Promise<Invoice | null>;
  /** One page of the matching invoices, latest first (`attention`: latest change first) */
  findPage(tenantId: string, filter: InvoiceFilter, page: PageRequest): Promise<InvoicePage>;
  findBySaleId(tenantId: string, saleId: string): Promise<Invoice[]>;
  countInFlight(tenantId: string): Promise<InFlightCounts>;
}
