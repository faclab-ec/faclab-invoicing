import { DateTime } from 'luxon';

import { IssuerReadinessService } from '#/modules/company-config/app/issuer-readiness';
import { ReadinessReport } from '#/modules/company-config/domain/readiness';

import { Invoice, InvoiceStatus } from '../../domain/invoice';
import { InvoicePage, InvoiceRepository } from '../../domain/repository';

export class GetInvoiceQuery {
  constructor(private readonly invoiceRepository: InvoiceRepository) {}

  async execute(id: string): Promise<Invoice | null> {
    return this.invoiceRepository.getInvoiceById(id);
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

  async execute(options: ListInvoicesOptions): Promise<InvoicePage> {
    return this.invoiceRepository.findPage(
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

  async execute(saleId: string): Promise<Invoice[]> {
    return this.invoiceRepository.findBySaleId(saleId);
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

  async execute(): Promise<InvoicingStatus> {
    const [report, inFlight] = await Promise.all([
      this.readiness.check(),
      this.invoiceRepository.findInFlight(),
    ]);
    return {
      ...report,
      pendingInvoices: inFlight.length,
      invoicesWithIssues: inFlight.filter((invoice) => invoice.issue !== null).length,
    };
  }
}
