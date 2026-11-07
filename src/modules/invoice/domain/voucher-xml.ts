import { RimpeRegime } from '#/modules/company-config/domain/company-config';

// contribuyenteRimpe of each regime, as the ficha técnica writes them (Anexo 22)
export const RIMPE_LEGENDS: Record<RimpeRegime, string> = {
  [RimpeRegime.ENTREPRENEUR]: 'CONTRIBUYENTE RÉGIMEN RIMPE',
  [RimpeRegime.POPULAR_BUSINESS]: 'CONTRIBUYENTE NEGOCIO POPULAR - RÉGIMEN RIMPE',
};

// campoAdicional with the RUC of the invoicing system's provider (Anexo 26)
export const PROVIDER_RUC_FIELD = 'RUC Proveedor';

// Lengths the SRI schemas allow (factura and notaCredito 1.1.0)
const MAX_TEXT = 300;
export const MAX_CODE = 25;

/** Who gets the document, as the schemas write it */
export interface VoucherBuyer {
  taxIdCode: string;
  name: string;
  taxId: string;
  // Contact data is optional: it only goes to infoAdicional
  email?: string | null;
  phone?: string | null;
  address?: string | null;
}

/** What every electronic document says of its issuer and of the document itself */
export interface VoucherIssue {
  environment: number;
  emissionType: number;
  companyName: string;
  companyTradeName: string;
  companyCode: string;
  companyMainAddress: string;
  // dirEstablecimiento is optional in the SRI schema: left out when the branch has no address
  companyBranchAddress: string | null;
  companyBranchCode: string;
  companySalePointCode: string;
  companyAccountingRequired: boolean;
  // The issuer's legends, from its fiscal profile; null when they don't apply
  companySpecialTaxpayerResolution: string | null;
  companyWithholdingAgentResolution: string | null;
  companyRimpeRegime: RimpeRegime | null;
  // RUC of whoever runs Faclab, the invoicing system the issuer uses (Anexo 26); null to leave out
  providerRuc: string | null;
  accessCode: string;
  sequence: string;
  voucherTypeCode: string;
  date: Date;
}

// Amounts as faclab-core sends them: rounded to cents, with the sale-level discount already
// prorated into each line
export interface VoucherItem {
  productId: string;
  sku: string | null;
  constructionMaterialCode?: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  discount: number; // line discount plus its share of the sale discount
  taxableBase: number; // precioTotalSinImpuesto and baseImponible
  taxCode: number;
  taxRate: number;
  taxAmount: number;
}

/**
 * The optional code of a line. A construction material takes the exact code of the SRI's Table 31
 * (Anexo 23 of the technical sheet, Res. NAC-DGERCGC24-00000013); anything else, its SKU. Null when
 * there is none or it doesn't fit: the schema admits it neither empty nor over 25 characters.
 */
export function auxiliaryCode(item: VoucherItem): string | null {
  const code = item.constructionMaterialCode || item.sku;
  return code && code.length <= MAX_CODE ? code : null;
}

export function formatDate(d: Date): string {
  const utcMinus5 = new Date(d.getTime() - 5 * 60 * 60 * 1000);
  return (
    String(utcMinus5.getUTCDate()).padStart(2, '0') +
    '/' +
    String(utcMinus5.getUTCMonth() + 1).padStart(2, '0') +
    '/' +
    String(utcMinus5.getUTCFullYear())
  );
}

// Money is summed in whole cents and written with two decimals, as the SRI
// expects; adding floats would leave values like 0.30000000000000004
export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

export function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function formatMoney(amount: number): string {
  return formatCents(toCents(amount));
}

/** One line of at most `max` characters: the schema allows no line breaks in these texts */
export function fitText(value: string, max: number = MAX_TEXT): string {
  return value
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim()
    .slice(0, max);
}

export function infoTributaria(input: VoucherIssue) {
  return {
    ambiente: input.environment,
    tipoEmision: input.emissionType,
    razonSocial: fitText(input.companyName),
    nombreComercial: fitText(input.companyTradeName),
    ruc: input.companyCode,
    claveAcceso: input.accessCode,
    codDoc: input.voucherTypeCode,
    estab: input.companyBranchCode,
    ptoEmi: input.companySalePointCode,
    secuencial: input.sequence,
    dirMatriz: fitText(input.companyMainAddress),
    // Only the legends that apply to the issuer, in the schema's order (Anexos 21 and 22)
    ...(input.companyWithholdingAgentResolution
      ? { agenteRetencion: input.companyWithholdingAgentResolution }
      : {}),
    ...(input.companyRimpeRegime
      ? { contribuyenteRimpe: RIMPE_LEGENDS[input.companyRimpeRegime] }
      : {}),
  };
}

/** The totals of a document, added up in cents from its lines */
export function lineTotals(items: VoucherItem[]) {
  const taxGroups = new Map<number, { baseImponible: number; valor: number }>();
  let withoutTaxes = 0;
  let discount = 0;
  let taxes = 0;
  for (const item of items) {
    const existing = taxGroups.get(item.taxCode) ?? { baseImponible: 0, valor: 0 };
    taxGroups.set(item.taxCode, {
      baseImponible: existing.baseImponible + toCents(item.taxableBase),
      valor: existing.valor + toCents(item.taxAmount),
    });
    withoutTaxes += toCents(item.taxableBase);
    discount += toCents(item.discount);
    taxes += toCents(item.taxAmount);
  }
  return {
    withoutTaxes,
    discount,
    taxes,
    totalImpuesto: Array.from(taxGroups.entries()).map(([codigoPorcentaje, group]) => ({
      codigo: 2,
      codigoPorcentaje,
      baseImponible: formatCents(group.baseImponible),
      valor: formatCents(group.valor),
    })),
  };
}

/** The part of a detalle both documents write alike: only its code tags differ */
export function detalleAmounts(item: VoucherItem) {
  return {
    descripcion: fitText(item.description),
    cantidad: item.quantity,
    precioUnitario: item.unitPrice,
    descuento: formatMoney(item.discount),
    precioTotalSinImpuesto: formatMoney(item.taxableBase),
    impuestos: {
      impuesto: [
        {
          codigo: 2,
          codigoPorcentaje: item.taxCode,
          tarifa: item.taxRate,
          baseImponible: formatMoney(item.taxableBase),
          valor: formatMoney(item.taxAmount),
        },
      ],
    },
  };
}

export function buildCampoAdicional(
  buyer: VoucherBuyer,
  providerRuc: string | null,
): { '@nombre': string; '#text': string }[] {
  const campos: { '@nombre': string; '#text': string }[] = [];

  if (buyer.address) {
    campos.push({ '@nombre': 'Dirección', '#text': fitText(buyer.address) });
  }
  if (buyer.phone) {
    campos.push({ '@nombre': 'Telefono', '#text': fitText(buyer.phone) });
  }
  if (buyer.email) {
    campos.push({ '@nombre': 'Email', '#text': fitText(buyer.email) });
  }
  if (providerRuc) {
    campos.push({ '@nombre': PROVIDER_RUC_FIELD, '#text': providerRuc });
  }

  return campos;
}
