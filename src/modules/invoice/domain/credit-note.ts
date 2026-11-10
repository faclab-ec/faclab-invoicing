import { SaleData } from './sale';
import { IvaCode } from './sri-catalogs';

export interface CreditNoteItem {
  product_id: number;
  sku: string | null;
  construction_material_code?: string | null;
  product_name: string | null;
  // A number in credit_notes.requested v1, decimal text since v2: stored notes keep either
  quantity: number | string;
  unit_price: string;
  // The sale's: the rate is the one of the date of the invoice it modifies (ficha técnica 2.34)
  tax_code: IvaCode;
  // Amounts of the credit note: rounded to cents, with the sale discount prorated
  invoice_discount: string;
  invoice_base: string;
  invoice_tax: string;
}

/** What faclab-core asks to credit (the payload of contracts/events/credit_notes.requested/) */
export interface CreditNoteRequest {
  credit_note_id: number;
  sale_id: number;
  invoice_id: string;
  refund_id: number | null;
  refund_number: string | null;
  reason: string;
  subtotal: string;
  tax: string;
  total: string;
  items: CreditNoteItem[];
}

/** The invoice a credit note modifies, as it was when the request came in */
export interface ModifiedInvoice {
  // 001-001-000000123
  number: string;
  // dd/mm/aaaa
  issueDate: string;
  // Who gets the credit note: the invoice's buyer, the only valid receiver
  customer: NonNullable<SaleData['customer']>;
}

/**
 * A credit note kept until its XML is built. It holds the invoice it modifies or, when that invoice
 * can't have one, why: `problem` rejects it without a number.
 */
export interface CreditNoteData extends CreditNoteRequest {
  modified: ModifiedInvoice | null;
  problem: string | null;
}
