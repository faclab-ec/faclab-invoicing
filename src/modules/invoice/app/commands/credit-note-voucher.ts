import { CreditNoteData } from '../../domain/credit-note';
import { buildCreditNoteXml } from '../../domain/credit-note-xml-builder';
import { Invoice } from '../../domain/invoice';
import { InvoiceInvalidError } from '../../domain/issue';
import { IVA_CODES, TAX_TYPE_CODES } from '../../domain/sri-catalogs';
import { VoucherIssue } from '../../domain/voucher-xml';
import { formatUsd, toCents, VoucherKind } from './invoice-voucher';

function dataOf(invoice: Invoice): CreditNoteData {
  if (!invoice.creditNote) throw new Error(`Credit note ${invoice.id} has no data`);
  return invoice.creditNote;
}

/** The notaCredito (codDoc 04) of an authorized invoice: to its buyer, for what faclab-core says */
export class CreditNoteVoucher implements VoucherKind {
  readonly label = 'credit note';

  /** The invoice doesn't admit one: why was decided when the request came in */
  rejection(invoice: Invoice): string | null {
    return dataOf(invoice).problem;
  }

  /** valorModificacion is the sum of its lines, and has to be what faclab-core credits */
  check(invoice: Invoice): void {
    const { items, total } = dataOf(invoice);
    const lines = items.reduce(
      (sum, item) => sum + toCents(item.invoice_base) + toCents(item.invoice_tax),
      0,
    );
    if (lines !== toCents(total)) {
      throw new InvoiceInvalidError(
        'INVOICE_DATA_INVALID',
        `The lines add up to USD ${formatUsd(lines)} but the credit note's total is USD ${formatUsd(toCents(total))}`,
      );
    }
  }

  buildXml(invoice: Invoice, issue: VoucherIssue): string {
    const { modified, reason, items } = dataOf(invoice);
    if (!modified) throw new Error(`Credit note ${invoice.id} has no invoice to modify`);
    const { customer } = modified;

    return buildCreditNoteXml({
      ...issue,
      customer: {
        taxIdCode: TAX_TYPE_CODES[customer.tax_type],
        name: customer.name,
        taxId: customer.tax_id,
        email: customer.email,
        phone: customer.phone,
        address: customer.address,
      },
      modifiedNumber: modified.number,
      modifiedDate: modified.issueDate,
      reason,
      items: items.map((item) => {
        const iva = IVA_CODES[item.tax_code];
        return {
          productId: String(item.product_id),
          sku: item.sku,
          constructionMaterialCode: item.construction_material_code,
          // No name means the product no longer exists in faclab-core; the SRI requires one
          description: item.product_name || `Producto ${item.product_id}`,
          quantity: item.quantity,
          unitPrice: parseFloat(item.unit_price),
          discount: parseFloat(item.invoice_discount),
          taxableBase: parseFloat(item.invoice_base),
          taxCode: iva.code,
          taxRate: iva.rate,
          taxAmount: parseFloat(item.invoice_tax),
        };
      }),
    });
  }
}
