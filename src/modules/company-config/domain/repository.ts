import { CompanyConfig } from './company-config';

export interface CompanyConfigRepository {
  /** Saves the fiscal profile; the invoice sequence stays as it is */
  save(config: CompanyConfig): Promise<CompanyConfig>;
  /** Its `invoiceSequence` is the number the next invoice will get */
  find(): Promise<CompanyConfig | null>;
  /** Takes the next invoice number: 1 for a new issuer */
  nextInvoiceSequence(): Promise<number>;
  /** The next invoice gets `next` */
  setNextInvoiceSequence(next: number): Promise<void>;
}
