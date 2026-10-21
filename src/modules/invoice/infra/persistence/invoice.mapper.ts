import { AccessCode } from '../../domain/access-code';
import { Invoice, InvoiceStatus, InvoiceStatusHistory } from '../../domain/invoice';
import { InvoiceIssueCode } from '../../domain/issue';
import { SaleData } from '../../domain/sale';

/** A row of `invoices`, with its `invoice_events` aggregated in order as `status_history` */
export interface InvoiceRow {
  id: string;
  tenant_id: string;
  sale_id: string;
  issuer_ruc: string | null;
  establishment: string;
  emission_point: string;
  establishment_address: string | null;
  status: string;
  sale: SaleData | null;
  access_code: string | null;
  sequence: string | null;
  signature_id: string | null;
  xml: string | null;
  issue_code: string | null;
  issue_message: string | null;
  issue_at: Date | null;
  attempts: number;
  next_attempt_at: Date | null;
  created_at: Date;
  updated_at: Date;
  version: number;
  // Built with json_agg: the dates come as ISO strings
  status_history: { status: string; occurred_at: string; description: string }[];
}

/** A row of `invoice_events`: `position` is the entry's index in the history */
export interface InvoiceEventRow {
  position: number;
  status: string;
  occurred_at: Date;
  description: string;
}

export function toInvoiceRow(invoice: Invoice): Omit<InvoiceRow, 'status_history'> {
  return {
    id: invoice.id,
    tenant_id: invoice.point.tenantId,
    sale_id: invoice.saleId,
    issuer_ruc: invoice.point.issuerRuc,
    establishment: invoice.point.establishment,
    emission_point: invoice.point.emissionPoint,
    establishment_address: invoice.point.establishmentAddress,
    status: invoice.status,
    sale: invoice.sale,
    access_code: invoice.accessCode?.value ?? null,
    sequence: invoice.sequence,
    signature_id: invoice.signatureId,
    xml: invoice.xml,
    issue_code: invoice.issue?.code ?? null,
    issue_message: invoice.issue?.message ?? null,
    issue_at: invoice.issue?.at ?? null,
    attempts: invoice.attempts,
    next_attempt_at: invoice.nextAttemptAt,
    created_at: invoice.createdAt,
    updated_at: invoice.updatedAt,
    version: invoice.version,
  };
}

export function toInvoiceEventRows(invoice: Invoice): InvoiceEventRow[] {
  return invoice.statusHistory.map((entry, position) => ({
    position,
    status: entry.name,
    occurred_at: entry.statusDate,
    description: entry.description ?? '',
  }));
}

export function fromInvoiceRow(row: InvoiceRow): Invoice {
  return new Invoice({
    id: row.id,
    saleId: row.sale_id,
    point: {
      tenantId: row.tenant_id,
      issuerRuc: row.issuer_ruc,
      establishment: row.establishment,
      emissionPoint: row.emission_point,
      establishmentAddress: row.establishment_address,
    },
    status: row.status as InvoiceStatus,
    sale: row.sale,
    accessCode: row.access_code ? AccessCode.create(row.access_code) : null,
    sequence: row.sequence,
    signatureId: row.signature_id,
    xml: row.xml,
    statusHistory: row.status_history.map(
      (entry) =>
        new InvoiceStatusHistory(
          entry.status as InvoiceStatus,
          new Date(entry.occurred_at),
          entry.description,
        ),
    ),
    issue:
      row.issue_code && row.issue_at
        ? {
            code: row.issue_code as InvoiceIssueCode,
            message: row.issue_message ?? '',
            at: row.issue_at,
          }
        : null,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  });
}
