/** The documents Faclab issues, by SRI code (Tabla 3): each one numbers on its own */
export enum VoucherType {
  INVOICE = '01',
  CREDIT_NOTE = '04',
}

/** Whose numbers a counter hands out: a company, an establishment, an emission point and a document type */
export interface SequenceKey {
  tenantId: string;
  establishment: string;
  emissionPoint: string;
  docType: string;
}

export interface Sequence extends SequenceKey {
  // The last number issued: 0 before the first one
  lastValue: number;
}

// The SRI's secuencial has 9 digits
export const MAX_SEQUENCE = 999_999_999;

export function formatSequence(value: number): string {
  return String(value).padStart(9, '0');
}
