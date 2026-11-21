import { VoucherType } from '#/modules/company-config/domain/sequence';

const DOCUMENT_TYPE: Record<VoucherType, string> = {
  [VoucherType.INVOICE]: 'invoice',
  [VoucherType.CREDIT_NOTE]: 'credit_note',
};

/** `faclab.document.type` of a document: invoice or credit_note */
export function documentTypeLabel(docType: VoucherType): string {
  return DOCUMENT_TYPE[docType] ?? 'other';
}
