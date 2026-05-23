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
  subtotal: number;
  totalDiscount: number;
  total: number;
  payments: Array<{ formaPago: string; amount: number }>;
  items: Array<{
    productId: string;
    sku: string;
    description: string;
    quantity: number;
    unitPrice: number;
    discount: number;
    subtotal: number;
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

function getInvoiceData(input: InvoiceXmlInput) {
  const taxGroups = new Map<number, { baseImponible: number; valor: number }>();
  for (const item of input.items) {
    const existing = taxGroups.get(item.taxCode) ?? { baseImponible: 0, valor: 0 };
    taxGroups.set(item.taxCode, {
      baseImponible: existing.baseImponible + item.subtotal,
      valor: existing.valor + item.taxAmount,
    });
  }

  const totalImpuesto = Array.from(taxGroups.entries()).map(([codigoPorcentaje, group]) => ({
    codigo: 2,
    codigoPorcentaje,
    baseImponible: group.baseImponible,
    valor: group.valor,
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
        totalSinImpuestos: input.subtotal,
        totalDescuento: input.totalDiscount,
        totalConImpuestos: {
          totalImpuesto,
        },
        propina: 0,
        importeTotal: input.total,
        moneda: 'DOLAR',
        pagos: {
          pago: [] as { formaPago: string; total: number }[],
        },
      },
      detalles: {
        detalle: [] as {
          codigoPrincipal: string;
          codigoAuxiliar: string;
          descripcion: string;
          cantidad: number;
          precioUnitario: number;
          descuento: number;
          precioTotalSinImpuesto: number;
          impuestos: {
            impuesto: {
              codigo: number;
              codigoPorcentaje: number;
              tarifa: number;
              baseImponible: number;
              valor: number;
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
      total: payment.amount,
    });
  });

  input.items.forEach((item) => {
    data.factura.detalles.detalle.push({
      codigoPrincipal: item.productId,
      codigoAuxiliar: item.sku,
      descripcion: item.description,
      cantidad: item.quantity,
      precioUnitario: item.unitPrice,
      descuento: item.discount,
      precioTotalSinImpuesto: item.subtotal,
      impuestos: {
        impuesto: [
          {
            codigo: 2,
            codigoPorcentaje: item.taxCode,
            tarifa: item.taxRate,
            baseImponible: item.subtotal,
            valor: item.taxAmount,
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
