// tax_type (event) → SRI identification code (Tabla 6)
export const TAX_TYPE_CODES: Record<string, string> = {
  RUC: '04',
  NATIONAL_ID: '05',
  PASSPORT: '06',
  FOREIGN_ID: '07',
};

// payment method (event) → SRI formaPago code (Tabla 24)
export const PAYMENT_METHOD_CODES: Record<string, string> = {
  CASH: '01',
  DEBIT_CARD: '16',
  CREDIT_CARD: '19',
  TRANSFER: '20',
  OTHER: '20',
};

// Domain IVA category (event) → SRI codigoPorcentaje (Tabla 17) + tarifa (%)
export const IVA_CODES = {
  VAT_0: { code: 0, rate: 0 },
  VAT_5: { code: 5, rate: 5 },
  VAT_8_TOURISM: { code: 8, rate: 8 },
  VAT_12: { code: 2, rate: 12 },
  VAT_13: { code: 10, rate: 13 },
  VAT_14: { code: 3, rate: 14 },
  VAT_15: { code: 4, rate: 15 },
  EXEMPT: { code: 7, rate: 0 },
  NOT_TAXED: { code: 6, rate: 0 },
} as const;

export type IvaCode = keyof typeof IVA_CODES;
export const IVA_CODE_KEYS = Object.keys(IVA_CODES) as [IvaCode, ...IvaCode[]];
