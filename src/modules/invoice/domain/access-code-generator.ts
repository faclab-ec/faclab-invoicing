import { CompanyConfig } from '#/modules/company-config/domain/company-config';

export function generateAccessCode(
  date: Date,
  companyConfig: CompanyConfig,
  saleId: number,
  sequence: string,
): string {
  const dateStr = formatDate(date);
  const voucherType = '01';
  const ruc = companyConfig.taxId;
  const environment = String(companyConfig.environment);
  const series =
    companyConfig.branchCode.padStart(3, '0') + companyConfig.salePointCode.padStart(3, '0');
  const seq = sequence.padStart(9, '0');
  const numericCode = String(saleId).padStart(8, '0');
  const emissionType = '1';

  const base48 =
    dateStr + voucherType + ruc + environment + series + seq + numericCode + emissionType;
  const checkDigit = calculateMod11(base48);

  return base48 + String(checkDigit);
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

function calculateMod11(digits: string): number {
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
