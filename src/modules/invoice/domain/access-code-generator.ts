import { randomInt } from 'crypto';

import { Environment } from '#/modules/company-config/domain/company-config';

export interface AccessCodeInput {
  date: Date;
  taxId: string;
  environment: Environment;
  establishment: string;
  emissionPoint: string;
  sequence: string;
  // 8 digits chosen by the issuer (ficha técnica, 5.2): random, kept with the invoice
  numericCode: string;
}

const NUMERIC_CODE_PATTERN = /^\d{8}$/;

/** A new random numeric code: it makes the access code unpredictable and says nothing of the sale */
export function generateNumericCode(): string {
  return String(randomInt(0, 100_000_000)).padStart(8, '0');
}

export function generateAccessCode(input: AccessCodeInput): string {
  if (!NUMERIC_CODE_PATTERN.test(input.numericCode)) {
    throw new Error(`Invalid numeric code: must be 8 digits, got "${input.numericCode}"`);
  }
  const dateStr = formatDate(input.date);
  const voucherType = '01';
  const ruc = input.taxId;
  const environment = String(input.environment);
  const series = input.establishment.padStart(3, '0') + input.emissionPoint.padStart(3, '0');
  const seq = input.sequence.padStart(9, '0');
  const emissionType = '1';

  const base48 =
    dateStr + voucherType + ruc + environment + series + seq + input.numericCode + emissionType;

  return base48 + String(mod11CheckDigit(base48));
}

// Ecuador date (UTC-5), like fechaEmision in the XML: the SRI checks they match,
// whatever the server's time zone
function formatDate(d: Date): string {
  const utcMinus5 = new Date(d.getTime() - 5 * 60 * 60 * 1000);
  return (
    String(utcMinus5.getUTCDate()).padStart(2, '0') +
    String(utcMinus5.getUTCMonth() + 1).padStart(2, '0') +
    String(utcMinus5.getUTCFullYear())
  );
}

/** Módulo 11 with weights 2 to 7 from the right; 11 becomes 0 and 10 becomes 1 (ficha técnica, 5.2) */
export function mod11CheckDigit(digits: string): number {
  const weights = [2, 3, 4, 5, 6, 7];
  let sum = 0;

  for (let i = digits.length - 1; i >= 0; i--) {
    const weight = weights[(digits.length - 1 - i) % weights.length];
    sum += parseInt(digits[i]) * weight;
  }

  const digit = 11 - (sum % 11);

  if (digit === 11) return 0;
  if (digit === 10) return 1;
  return digit;
}
