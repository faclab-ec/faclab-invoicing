import { AccessCode } from '../../domain/access-code';
import { Invoice, InvoiceStatus, InvoiceStatusHistory } from '../../domain/invoice';
import { InvoiceIssueCode } from '../../domain/issue';
import { SaleData } from '../../domain/sale';

// Invoices written before the `pending` status existed lack the newer fields
export interface InvoiceRecord {
  id: string;
  saleId: string;
  status: string;
  accessCode?: string | null;
  sequence?: string | null;
  signatureId?: string | null;
  xml?: string | null;
  sale?: SaleData | null;
  statusHistory: {
    name: string;
    statusDate: string;
    description?: string;
  }[];
  issue?: { code: string; message: string; at: string } | null;
  attempts?: number;
  nextAttemptAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  version?: number;
}

export function toInvoiceRecord(invoice: Invoice): InvoiceRecord {
  return {
    id: invoice.id,
    saleId: invoice.saleId,
    status: invoice.status,
    accessCode: invoice.accessCode?.value ?? null,
    sequence: invoice.sequence,
    signatureId: invoice.signatureId,
    xml: invoice.xml,
    sale: invoice.sale,
    statusHistory: invoice.statusHistory.map((h) => ({
      name: h.name,
      statusDate: h.statusDate.toISOString(),
      description: h.description ?? '',
    })),
    issue: invoice.issue && {
      code: invoice.issue.code,
      message: invoice.issue.message,
      at: invoice.issue.at.toISOString(),
    },
    attempts: invoice.attempts,
    nextAttemptAt: invoice.nextAttemptAt?.toISOString() ?? null,
    createdAt: invoice.createdAt.toISOString(),
    updatedAt: invoice.updatedAt.toISOString(),
    version: invoice.version,
  };
}

export function fromInvoiceRecord(record: InvoiceRecord): Invoice {
  const statusHistory = record.statusHistory.map(
    (h) => new InvoiceStatusHistory(h.name as InvoiceStatus, new Date(h.statusDate), h.description),
  );
  const firstChange = statusHistory[0]?.statusDate ?? new Date(0);
  const lastChange = statusHistory[statusHistory.length - 1]?.statusDate ?? firstChange;

  return new Invoice({
    id: record.id,
    saleId: record.saleId,
    status: record.status as InvoiceStatus,
    sale: record.sale ?? null,
    accessCode: record.accessCode ? AccessCode.create(record.accessCode) : null,
    sequence: record.sequence ?? null,
    signatureId: record.signatureId ?? null,
    xml: record.xml ?? null,
    statusHistory,
    issue: record.issue
      ? {
          code: record.issue.code as InvoiceIssueCode,
          message: record.issue.message,
          at: new Date(record.issue.at),
        }
      : null,
    attempts: record.attempts ?? 0,
    nextAttemptAt: record.nextAttemptAt ? new Date(record.nextAttemptAt) : null,
    createdAt: record.createdAt ? new Date(record.createdAt) : firstChange,
    updatedAt: record.updatedAt ? new Date(record.updatedAt) : lastChange,
    version: record.version ?? 0,
  });
}
