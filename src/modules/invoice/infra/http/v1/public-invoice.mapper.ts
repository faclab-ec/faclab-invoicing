import { documentTypeOf, publicStatus } from '../../../app/queries/public-invoice.queries';
import { Invoice, InvoiceStatus } from '../../../domain/invoice';

/** A document as the public API shows it (S6.3): only what its contract lists */
export function toPublicDocument(invoice: Invoice) {
  const rejection =
    invoice.status === InvoiceStatus.REJECTED
      ? (invoice.statusHistory.at(-1)?.description ?? null)
      : null;
  return {
    id: invoice.id,
    documentType: documentTypeOf(invoice.docType),
    saleId: Number(invoice.saleId),
    creditedInvoiceId: invoice.creditNote?.invoice_id ?? null,
    branchId: invoice.point.branchId ?? null,
    establishment: invoice.point.establishment,
    emissionPoint: invoice.point.emissionPoint,
    number: invoice.number,
    accessCode: invoice.accessCode?.value ?? null,
    status: publicStatus(invoice.status),
    authorizationNumber: invoice.authorization?.number ?? null,
    authorizedAt: invoice.authorization?.authorizedAt.toISOString() ?? null,
    rejectionReason: rejection || null,
    total: invoice.creditNote?.total ?? invoice.sale?.total ?? null,
    createdAt: invoice.createdAt.toISOString(),
    updatedAt: invoice.updatedAt.toISOString(),
  };
}
