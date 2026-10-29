import { DateTime } from 'luxon';

import { IssuerReadinessService } from '#/modules/company-config/app/issuer-readiness';
import { ReadinessReport } from '#/modules/company-config/domain/readiness';

import { Invoice, InvoiceStatus } from '../../domain/invoice';
import { DocumentStorage } from '../../domain/ports';
import { InvoicePage, InvoiceRepository } from '../../domain/repository';

// Every query reads the invoices of one company: the one of the token

export class GetInvoiceQuery {
  constructor(private readonly invoiceRepository: InvoiceRepository) {}

  async execute(tenantId: string, id: string): Promise<Invoice | null> {
    return this.invoiceRepository.findForTenant(tenantId, id);
  }
}

export interface AuthorizedXml {
  // <access code>.xml
  fileName: string;
  xml: string;
}

/** The authorized XML of an invoice of the company, as kept in the document storage */
export class GetAuthorizedXmlQuery {
  constructor(
    private readonly invoiceRepository: InvoiceRepository,
    private readonly documentStorage: DocumentStorage,
  ) {}

  /** Null when the invoice isn't found, isn't authorized or was authorized before S4.1 */
  async execute(tenantId: string, id: string): Promise<AuthorizedXml | null> {
    const invoice = await this.invoiceRepository.findForTenant(tenantId, id);
    const key = invoice?.authorization?.xmlKey;
    if (!invoice || !key) return null;
    const xml = await this.documentStorage.get(key);
    if (xml === null) return null;
    return { fileName: `${invoice.requireAccessCode().value}.xml`, xml };
  }
}

export interface ListInvoicesOptions {
  // Only unfinished invoices that are stuck or waiting to start, latest change first
  attention?: boolean;
  status?: InvoiceStatus;
  // Days (YYYY-MM-DD) in the service's timezone, both included
  fromDate?: string;
  toDate?: string;
  limit: number;
  offset: number;
}

export class ListInvoicesQuery {
  constructor(
    private readonly invoiceRepository: InvoiceRepository,
    private readonly timezone: string,
  ) {}

  async execute(tenantId: string, options: ListInvoicesOptions): Promise<InvoicePage> {
    return this.invoiceRepository.findPage(
      tenantId,
      {
        attention: options.attention,
        status: options.status,
        createdFrom: options.fromDate ? this.startOfDay(options.fromDate) : undefined,
        // The day after `toDate`, excluded
        createdBefore: options.toDate ? this.startOfDay(options.toDate, 1) : undefined,
      },
      { limit: options.limit, offset: options.offset },
    );
  }

  private startOfDay(day: string, plusDays = 0): Date {
    return DateTime.fromISO(day, { zone: this.timezone })
      .plus({ days: plusDays })
      .startOf('day')
      .toJSDate();
  }
}

export class FindInvoicesBySaleIdQuery {
  constructor(private readonly invoiceRepository: InvoiceRepository) {}

  async execute(tenantId: string, saleId: string): Promise<Invoice[]> {
    return this.invoiceRepository.findBySaleId(tenantId, saleId);
  }
}

export interface InvoicingStatus extends ReadinessReport {
  // Invoices not yet authorized or rejected
  pendingInvoices: number;
  // Of those, the ones whose last attempt failed
  invoicesWithIssues: number;
}

export class GetInvoicingStatusQuery {
  constructor(
    private readonly readiness: IssuerReadinessService,
    private readonly invoiceRepository: InvoiceRepository,
  ) {}

  /** The company's issuer and its invoices: another company's state never shows here */
  async execute(tenantId: string): Promise<InvoicingStatus> {
    const [report, inFlight] = await Promise.all([
      this.readiness.check(tenantId),
      this.invoiceRepository.countInFlight(tenantId),
    ]);
    return {
      ...report,
      pendingInvoices: inFlight.total,
      invoicesWithIssues: inFlight.withIssues,
    };
  }
}
