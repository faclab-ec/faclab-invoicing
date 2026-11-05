import { create } from 'xmlbuilder2';

import {
  auxiliaryCode,
  buildCampoAdicional,
  detalleAmounts,
  fitText,
  formatCents,
  formatDate,
  infoTributaria,
  lineTotals,
  VoucherBuyer,
  VoucherIssue,
  VoucherItem,
} from './voucher-xml';

// codDocModificado: a credit note only modifies invoices here (Tabla 3)
const MODIFIED_INVOICE_CODE = '01';

export interface CreditNoteXmlInput extends VoucherIssue {
  // The invoice's buyer: the schema's ficha (5.7) requires one identified, never the final consumer
  customer: VoucherBuyer;
  modifiedNumber: string; // numDocModificado: 001-001-000000123
  modifiedDate: string; // fechaEmisionDocSustento: dd/mm/aaaa
  reason: string; // motivo
  items: VoucherItem[];
}

/** The notaCredito 1.1.0 of the SRI: its totals come from its lines, in cents */
export function buildCreditNoteXml(input: CreditNoteXmlInput): string {
  const totals = lineTotals(input.items);
  const campoAdicional = buildCampoAdicional(input.customer, input.providerRuc);

  return create({
    notaCredito: {
      '@id': 'comprobante',
      '@version': '1.1.0',
      infoTributaria: infoTributaria(input),
      infoNotaCredito: {
        fechaEmision: formatDate(input.date),
        ...(input.companyBranchAddress
          ? { dirEstablecimiento: fitText(input.companyBranchAddress) }
          : {}),
        tipoIdentificacionComprador: input.customer.taxIdCode,
        razonSocialComprador: fitText(input.customer.name),
        identificacionComprador: input.customer.taxId,
        ...(input.companySpecialTaxpayerResolution
          ? { contribuyenteEspecial: input.companySpecialTaxpayerResolution }
          : {}),
        obligadoContabilidad: input.companyAccountingRequired ? 'SI' : 'NO',
        codDocModificado: MODIFIED_INVOICE_CODE,
        numDocModificado: input.modifiedNumber,
        fechaEmisionDocSustento: input.modifiedDate,
        totalSinImpuestos: formatCents(totals.withoutTaxes),
        valorModificacion: formatCents(totals.withoutTaxes + totals.taxes),
        moneda: 'DOLAR',
        totalConImpuestos: { totalImpuesto: totals.totalImpuesto },
        motivo: fitText(input.reason),
      },
      detalles: {
        detalle: input.items.map((item) => {
          const code = auxiliaryCode(item);
          return {
            codigoInterno: item.productId,
            // The same code as in its invoice's codigoAuxiliar
            ...(code ? { codigoAdicional: code } : {}),
            ...detalleAmounts(item),
          };
        }),
      },
      ...(campoAdicional.length > 0 && { infoAdicional: { campoAdicional } }),
    },
  }).end({ prettyPrint: true });
}
