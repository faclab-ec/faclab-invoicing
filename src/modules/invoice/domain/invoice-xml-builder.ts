import { create } from 'xmlbuilder2';

import { RimpeRegime } from '#/modules/company-config/domain/company-config';

// contribuyenteRimpe of each regime, as the ficha técnica writes them (Anexo 22)
export const RIMPE_LEGENDS: Record<RimpeRegime, string> = {
  [RimpeRegime.ENTREPRENEUR]: 'CONTRIBUYENTE RÉGIMEN RIMPE',
  [RimpeRegime.POPULAR_BUSINESS]: 'CONTRIBUYENTE NEGOCIO POPULAR - RÉGIMEN RIMPE',
};

// campoAdicional with the RUC of the invoicing system's provider (Anexo 26)
export const PROVIDER_RUC_FIELD = 'RUC Proveedor';

// Lengths the SRI schema allows (factura 1.1.0)
const MAX_TEXT = 300;
const MAX_CODE = 25;

export interface InvoiceXmlInput {
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
  customer: {
    taxIdCode: string;
    name: string;
    taxId: string;
    // Contact data is optional: it only goes to infoAdicional
    email?: string | null;
    phone?: string | null;
    address?: string | null;
  };
  total: number;
  payments: Array<{ formaPago: string; amount: number }>;
  // Amounts as faclab-core sends them: rounded to cents, with the sale-level
  // discount already prorated into each line
  items: Array<{
    productId: string;
    sku: string | null;
    description: string;
    quantity: number;
    unitPrice: number;
    discount: number; // line discount plus its share of the sale discount
    taxableBase: number; // precioTotalSinImpuesto and baseImponible
    taxCode: number;
    taxRate: number;
    taxAmount: number;
  }>;
}

export function buildInvoiceXml(input: InvoiceXmlInput): string {
  const data = getInvoiceData(input);
  return create(data).end({ prettyPrint: true });
}

function formatDate(d: Date): string {
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
function toCents(amount: number): number {
  return Math.round(amount * 100);
}

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

function formatMoney(amount: number): string {
  return formatCents(toCents(amount));
}

/** One line of at most `max` characters: the schema allows no line breaks in these texts */
function fitText(value: string, max: number = MAX_TEXT): string {
  return value
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim()
    .slice(0, max);
}

function getInvoiceData(input: InvoiceXmlInput) {
  const taxGroups = new Map<number, { baseImponible: number; valor: number }>();
  let totalSinImpuestos = 0;
  let totalDescuento = 0;
  for (const item of input.items) {
    const existing = taxGroups.get(item.taxCode) ?? { baseImponible: 0, valor: 0 };
    taxGroups.set(item.taxCode, {
      baseImponible: existing.baseImponible + toCents(item.taxableBase),
      valor: existing.valor + toCents(item.taxAmount),
    });
    totalSinImpuestos += toCents(item.taxableBase);
    totalDescuento += toCents(item.discount);
  }

  const totalImpuesto = Array.from(taxGroups.entries()).map(([codigoPorcentaje, group]) => ({
    codigo: 2,
    codigoPorcentaje,
    baseImponible: formatCents(group.baseImponible),
    valor: formatCents(group.valor),
  }));

  const campoAdicional = buildCampoAdicional(input.customer, input.providerRuc);

  const data = {
    factura: {
      '@id': 'comprobante',
      '@version': '1.1.0',
      infoTributaria: {
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
      },
      infoFactura: {
        fechaEmision: formatDate(input.date),
        // Optional: an empty element would break the SRI schema
        ...(input.companyBranchAddress
          ? { dirEstablecimiento: fitText(input.companyBranchAddress) }
          : {}),
        ...(input.companySpecialTaxpayerResolution
          ? { contribuyenteEspecial: input.companySpecialTaxpayerResolution }
          : {}),
        obligadoContabilidad: input.companyAccountingRequired ? 'SI' : 'NO',
        tipoIdentificacionComprador: input.customer.taxIdCode,
        razonSocialComprador: fitText(input.customer.name),
        identificacionComprador: input.customer.taxId,
        totalSinImpuestos: formatCents(totalSinImpuestos),
        totalDescuento: formatCents(totalDescuento),
        totalConImpuestos: {
          totalImpuesto,
        },
        propina: 0,
        importeTotal: formatMoney(input.total),
        moneda: 'DOLAR',
        // A pagos element needs at least one pago: left out when the sale has none
        ...(input.payments.length > 0 && {
          pagos: {
            pago: input.payments.map((payment) => ({
              formaPago: payment.formaPago,
              total: formatMoney(payment.amount),
            })),
          },
        }),
      },
      detalles: {
        detalle: [] as {
          codigoPrincipal: string;
          codigoAuxiliar?: string;
          descripcion: string;
          cantidad: number;
          precioUnitario: number;
          descuento: string;
          precioTotalSinImpuesto: string;
          impuestos: {
            impuesto: {
              codigo: number;
              codigoPorcentaje: number;
              tarifa: number;
              baseImponible: string;
              valor: string;
            }[];
          };
        }[],
      },
      ...(campoAdicional.length > 0 && {
        infoAdicional: { campoAdicional },
      }),
    },
  };

  input.items.forEach((item) => {
    data.factura.detalles.detalle.push({
      codigoPrincipal: item.productId,
      // Optional in the SRI schema, but never empty; left out when it doesn't fit (25 characters)
      ...(item.sku && item.sku.length <= MAX_CODE ? { codigoAuxiliar: item.sku } : {}),
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
    });
  });

  return data;
}

function buildCampoAdicional(
  customer: InvoiceXmlInput['customer'],
  providerRuc: string | null,
): { '@nombre': string; '#text': string }[] {
  const campos: { '@nombre': string; '#text': string }[] = [];

  if (customer.address) {
    campos.push({ '@nombre': 'Dirección', '#text': fitText(customer.address) });
  }
  if (customer.phone) {
    campos.push({ '@nombre': 'Telefono', '#text': fitText(customer.phone) });
  }
  if (customer.email) {
    campos.push({ '@nombre': 'Email', '#text': fitText(customer.email) });
  }
  if (providerRuc) {
    campos.push({ '@nombre': PROVIDER_RUC_FIELD, '#text': providerRuc });
  }

  return campos;
}
