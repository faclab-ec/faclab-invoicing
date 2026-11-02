import { CompanyConfig } from '#/modules/company-config/domain/company-config';

import { Invoice } from '../../domain/invoice';
import { buildInvoiceXml } from '../../domain/invoice-xml-builder';
import { InvoiceInvalidError } from '../../domain/issue';
import { SaleData } from '../../domain/sale';
import {
  FINAL_CONSUMER,
  IVA_CODES,
  PAYMENT_METHOD_CODES,
  TAX_TYPE_CODES,
} from '../../domain/sri-catalogs';
import { VoucherIssue } from '../../domain/voucher-xml';

/**
 * What changes between the documents PrepareInvoiceCommand builds: everything else about preparing
 * one (the issuer, its number, its access code, the schema) is the same.
 */
export interface VoucherKind {
  // How the logs and the issues name it
  readonly label: string;
  /** Why it can't be issued at all: it ends rejected, without a number */
  rejection(invoice: Invoice, config?: CompanyConfig): string | null;
  /** Throws InvoiceInvalidError when its amounts don't add up */
  check(invoice: Invoice): void;
  buildXml(invoice: Invoice, issue: VoucherIssue): string;
}

export const toCents = (amount: string | number): number => Math.round(Number(amount) * 100);

export const formatUsd = (cents: number): string => (cents / 100).toFixed(2);

export function saleOf(invoice: Invoice): SaleData {
  if (!invoice.sale) throw new Error(`Invoice ${invoice.id} has no sale data`);
  return invoice.sale;
}

/** The factura (codDoc 01) of a sale, to its customer or to the final consumer */
export class InvoiceVoucher implements VoucherKind {
  readonly label = 'invoice';

  // finalConsumerMaxTotal: highest total of an invoice to the final consumer, in USD (ficha técnica,
  // 9.10: 50)
  constructor(private readonly finalConsumerMaxTotal: number) {}

  /** A sale to the final consumer over the limit */
  rejection(invoice: Invoice): string | null {
    const sale = saleOf(invoice);
    if (sale.customer) return null;
    const total = toCents(sale.total);
    const limit = toCents(this.finalConsumerMaxTotal);
    if (total <= limit) return null;
    return `An invoice to the final consumer can't exceed USD ${formatUsd(limit)} (this sale: USD ${formatUsd(total)}): the sale needs the buyer's identification`;
  }

  /** pagos must add up to importeTotal: faclab-core sends what each payment applied (S3.3) */
  check(invoice: Invoice): void {
    const sale = saleOf(invoice);
    const paid = sale.payments.reduce((sum, payment) => sum + toCents(payment.amount), 0);
    const total = toCents(sale.total);
    if (paid !== total) {
      throw new InvoiceInvalidError(
        'INVOICE_DATA_INVALID',
        `The payments add up to USD ${formatUsd(paid)} but the sale's total is USD ${formatUsd(total)}`,
      );
    }
  }

  buildXml(invoice: Invoice, issue: VoucherIssue): string {
    const sale = saleOf(invoice);
    const customer = sale.customer
      ? {
          taxIdCode: TAX_TYPE_CODES[sale.customer.tax_type] ?? FINAL_CONSUMER.taxIdCode,
          name: sale.customer.name,
          taxId: sale.customer.tax_id,
          email: sale.customer.email,
          phone: sale.customer.phone,
          address: sale.customer.address,
        }
      : { ...FINAL_CONSUMER };

    return buildInvoiceXml({
      ...issue,
      customer,
      total: parseFloat(sale.total),
      payments: sale.payments.map((p) => ({
        formaPago: PAYMENT_METHOD_CODES[p.method] ?? '20',
        amount: parseFloat(p.amount),
      })),
      items: sale.items.map((item) => {
        const iva = IVA_CODES[item.tax_code];
        return {
          productId: String(item.product_id),
          sku: item.sku,
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
