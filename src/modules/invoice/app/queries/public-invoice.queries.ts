import { VoucherType } from '#/modules/company-config/domain/sequence';

import { Invoice, InvoiceStatus } from '../../domain/invoice';
import { InvoicePage, InvoiceRepository, InvoiceSortField } from '../../domain/repository';

// The public API (S6.3): an integration client reads the electronic documents of its company,
// only those of the branches it may see, with statuses and types of its own contract

/** Where a document is, as an integration sees it: still on its way, or final */
export const PUBLIC_STATUSES = ['PROCESSING', 'AUTHORIZED', 'REJECTED'] as const;
export type PublicStatus = (typeof PUBLIC_STATUSES)[number];

export function publicStatus(status: InvoiceStatus): PublicStatus {
  if (status === InvoiceStatus.AUTHORIZED) return 'AUTHORIZED';
  if (status === InvoiceStatus.REJECTED) return 'REJECTED';
  return 'PROCESSING';
}

function statusesOf(status: PublicStatus): InvoiceStatus[] {
  return Object.values(InvoiceStatus).filter((s) => publicStatus(s) === status);
}

export const DOCUMENT_TYPES = {
  INVOICE: VoucherType.INVOICE,
  CREDIT_NOTE: VoucherType.CREDIT_NOTE,
} as const;
export type DocumentType = keyof typeof DOCUMENT_TYPES;

export const documentTypeOf = (docType: VoucherType): DocumentType =>
  docType === VoucherType.CREDIT_NOTE ? 'CREDIT_NOTE' : 'INVOICE';

export const SORT_FIELDS: InvoiceSortField[] = ['createdAt', 'updatedAt', 'id'];

export interface PublicInvoiceOptions {
  limit: number;
  offset: number;
  // A field of SORT_FIELDS, with a leading `-` descending
  sort?: string;
  saleId?: number;
  status?: PublicStatus;
  documentType?: DocumentType;
  branchId?: number;
  // Created at or after `from` and before `to` (ISO 8601)
  from?: string;
  to?: string;
  updatedSince?: string;
}

/** The branches an integration client may see: null, every one */
export type BranchScope = number[] | null;

const visible = (invoice: Invoice, branches: BranchScope) =>
  branches === null ||
  (invoice.point.branchId != null && branches.includes(invoice.point.branchId));

export class ListPublicInvoicesQuery {
  constructor(private readonly invoiceRepository: InvoiceRepository) {}

  /** One page in a stable order: `sort`, else `updatedAt` when syncing, else `createdAt` */
  async execute(
    tenantId: string,
    branches: BranchScope,
    options: PublicInvoiceOptions,
  ): Promise<InvoicePage> {
    const sort = options.sort ?? (options.updatedSince ? 'updatedAt' : 'createdAt');
    return this.invoiceRepository.findPage(
      tenantId,
      {
        statuses: options.status ? statusesOf(options.status) : undefined,
        docType: options.documentType ? DOCUMENT_TYPES[options.documentType] : undefined,
        saleId: options.saleId !== undefined ? String(options.saleId) : undefined,
        branchId: options.branchId,
        branchIds: branches,
        createdFrom: options.from ? new Date(options.from) : undefined,
        createdBefore: options.to ? new Date(options.to) : undefined,
        updatedSince: options.updatedSince ? new Date(options.updatedSince) : undefined,
      },
      {
        limit: options.limit,
        offset: options.offset,
        sort: {
          field: sort.replace(/^-/, '') as InvoiceSortField,
          descending: sort.startsWith('-'),
        },
      },
    );
  }
}

export class GetPublicInvoiceQuery {
  constructor(private readonly invoiceRepository: InvoiceRepository) {}

  /** A document of the company in a branch the client may see; null otherwise */
  async execute(tenantId: string, branches: BranchScope, id: string): Promise<Invoice | null> {
    const invoice = await this.invoiceRepository.findForTenant(tenantId, id);
    return invoice && visible(invoice, branches) ? invoice : null;
  }
}
