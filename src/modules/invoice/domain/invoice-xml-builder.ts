import { create } from 'xmlbuilder2';

export interface InvoiceXmlInput {
  environment: number;
  emissionType: number;
  companyName: string;
  companyTradeName: string;
  companyCode: string;
  companyMainAddress: string;
  companyBranchAddress: string;
  companyBranchCode: string;
  companySalePointCode: string;
  companyAccountingRequired: boolean;
  accessCode: string;
  sequence: string;
  voucherTypeCode: string;
  date: Date;
  customer: {
    taxIdCode: string;
    name: string;
    taxId: string;
    email: string;
    phone?: string | null;
    address?: string | null;
  };
  total: number;
  payments: Array<{ formaPago: string; amount: number }>;
  // Amounts as faclab-core sends them: rounded to cents, with the sale-level
  // discount already prorated into each line
  items: Array<{
    productId: string;
    sku: string;
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

  const campoAdicional = buildCampoAdicional(input.customer);

  const data = {
    factura: {
      '@id': 'comprobante',
      '@version': '1.1.0',
      infoTributaria: {
        ambiente: input.environment,
        tipoEmision: input.emissionType,
        razonSocial: input.companyName,
        nombreComercial: input.companyTradeName,
        ruc: input.companyCode,
        claveAcceso: input.accessCode,
        codDoc: input.voucherTypeCode,
        estab: input.companyBranchCode,
        ptoEmi: input.companySalePointCode,
        secuencial: input.sequence,
        dirMatriz: input.companyMainAddress,
      },
      infoFactura: {
        fechaEmision: formatDate(input.date),
        dirEstablecimiento: input.companyBranchAddress,
        obligadoContabilidad: input.companyAccountingRequired ? 'SI' : 'NO',
        tipoIdentificacionComprador: input.customer.taxIdCode,
        razonSocialComprador: input.customer.name,
        identificacionComprador: input.customer.taxId,
        totalSinImpuestos: formatCents(totalSinImpuestos),
        totalDescuento: formatCents(totalDescuento),
        totalConImpuestos: {
          totalImpuesto,
        },
        propina: 0,
        importeTotal: formatMoney(input.total),
        moneda: 'DOLAR',
        pagos: {
          pago: [] as { formaPago: string; total: string }[],
        },
      },
      detalles: {
        detalle: [] as {
          codigoPrincipal: string;
          codigoAuxiliar: string;
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

  input.payments.forEach((payment) => {
    data.factura.infoFactura.pagos.pago.push({
      formaPago: payment.formaPago,
      total: formatMoney(payment.amount),
    });
  });

  input.items.forEach((item) => {
    data.factura.detalles.detalle.push({
      codigoPrincipal: item.productId,
      codigoAuxiliar: item.sku,
      descripcion: item.description,
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
): { '@nombre': string; '#text': string }[] {
  const campos: { '@nombre': string; '#text': string }[] = [];

  if (customer.address) {
    campos.push({ '@nombre': 'Dirección', '#text': customer.address });
  }
  if (customer.phone) {
    campos.push({ '@nombre': 'Telefono', '#text': customer.phone });
  }
  if (customer.email) {
    campos.push({ '@nombre': 'Email', '#text': customer.email });
  }

  return campos;
}
