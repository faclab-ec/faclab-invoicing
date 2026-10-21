import { IvaCode } from './sri-catalogs';

/**
 * Who issues the invoice of a sale and from where, as `sales.confirmed` v2 says: the company
 * (faclab-core tenant), its RUC and the establishment and emission point of the sale.
 */
export interface IssuingPoint {
  tenantId: string;
  // The RUC of the company in faclab-core; null in a v1 message, which doesn't say
  issuerRuc: string | null;
  establishment: string;
  emissionPoint: string;
  // dirEstablecimiento; null when the branch has no address
  establishmentAddress: string | null;
}

/**
 * The confirmed sale as faclab-core sends it in `sales.confirmed` (the payload of the contracts in
 * contracts/events/sales.confirmed/, without the issuing point). The invoice keeps it until its XML
 * is built, so it can wait for the issuer to be ready.
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
