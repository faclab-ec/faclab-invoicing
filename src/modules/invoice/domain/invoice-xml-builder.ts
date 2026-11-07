import { create } from 'xmlbuilder2';

import {
  auxiliaryCode,
  buildCampoAdicional,
  detalleAmounts,
  fitText,
  formatCents,
  formatDate,
  formatMoney,
  infoTributaria,
  lineTotals,
  VoucherBuyer,
  VoucherIssue,
  VoucherItem,
} from './voucher-xml';

export interface InvoiceXmlInput extends VoucherIssue {
  customer: VoucherBuyer;
  total: number;
  payments: Array<{ formaPago: string; amount: number }>;
  items: VoucherItem[];
}

export function buildInvoiceXml(input: InvoiceXmlInput): string {
  const data = getInvoiceData(input);
  return create(data).end({ prettyPrint: true });
}

function getInvoiceData(input: InvoiceXmlInput) {
  const totals = lineTotals(input.items);
  const campoAdicional = buildCampoAdicional(input.customer, input.providerRuc);

  return {
    factura: {
      '@id': 'comprobante',
      '@version': '1.1.0',
      infoTributaria: infoTributaria(input),
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
        totalSinImpuestos: formatCents(totals.withoutTaxes),
        totalDescuento: formatCents(totals.discount),
        totalConImpuestos: {
          totalImpuesto: totals.totalImpuesto,
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
        detalle: input.items.map((item) => {
          const code = auxiliaryCode(item);
          return {
            codigoPrincipal: item.productId,
            ...(code ? { codigoAuxiliar: code } : {}),
            ...detalleAmounts(item),
          };
        }),
      },
      ...(campoAdicional.length > 0 && {
        infoAdicional: { campoAdicional },
      }),
    },
  };
}
