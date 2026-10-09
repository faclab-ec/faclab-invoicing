import { IssuerReadinessService } from '#/modules/company-config/app/issuer-readiness';
import { ReadinessReport } from '#/modules/company-config/domain/readiness';

import { Invoice } from '../../domain/invoice';
import { InvoiceRepository } from '../../domain/repository';

export class GetInvoiceQuery {
  constructor(private readonly invoiceRepository: InvoiceRepository) {}

  async execute(id: string): Promise<Invoice | null> {
    return this.invoiceRepository.getInvoiceById(id);
  }
}

export class ListInvoicesQuery {
  constructor(private readonly invoiceRepository: InvoiceRepository) {}

  /** `attention`: only unfinished invoices that are stuck or waiting to start, latest first */
  async execute(options: { attention?: boolean } = {}): Promise<Invoice[]> {
    if (!options.attention) return this.invoiceRepository.findAll();
    const invoices = await this.invoiceRepository.findInFlight();
    return invoices
      .filter((invoice) => invoice.needsAttention)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
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
