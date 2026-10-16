import { IvaCode } from './sri-catalogs';

/**
 * The confirmed sale as faclab-core sends it in `sales.confirmed` (contract v1 in
 * contracts/events/sales.confirmed/). The invoice keeps it until its XML is built, so it
 * can wait for the issuer to be ready.
 */
export interface SaleData {
  sale_id: number;
  source: string;
  subtotal: string;
  total_discount: string;
  total: string;
  customer: {
    id: number;
    name: string;
    tax_id: string;
    tax_type: 'RUC' | 'NATIONAL_ID' | 'PASSPORT' | 'FOREIGN_ID';
    email: string | null;
    phone: string | null;
    address: string | null;
  } | null;
  items: {
    product_id: number;
    sku: string | null;
    product_name: string | null;
    quantity: number;
    unit_price: string;
    discount: string;
    tax_code: IvaCode;
    tax_amount: string;
    subtotal: string;
    invoice_discount: string;
    invoice_base: string;
    invoice_tax: string;
  }[];
  payments: {
    method: 'CASH' | 'CREDIT_CARD' | 'DEBIT_CARD' | 'TRANSFER' | 'OTHER';
    amount: string;
  }[];
}
