import { create } from 'xmlbuilder2';

import { AuthorizedVoucher } from './voucher';

/**
 * The authorized invoice as it is kept and handed to the buyer: the SRI's authorization (status,
 * number, date and environment) with the signed XML it authorized, unchanged, in a CDATA section.
 */
export function buildAuthorizedXml(authorized: AuthorizedVoucher): string {
  return create({ version: '1.0', encoding: 'UTF-8' })
    .ele('autorizacion')
    .ele('estado')
    .txt('AUTORIZADO')
    .up()
    .ele('numeroAutorizacion')
    .txt(authorized.number)
    .up()
    .ele('fechaAutorizacion')
    .txt(authorized.date)
    .up()
    .ele('ambiente')
    .txt(authorized.environment)
    .up()
    .ele('comprobante')
    .dat(authorized.voucherXml)
    .up()
    .ele('mensajes')
    .up()
    .end({ prettyPrint: true });
}

/** Where the authorized XML of an invoice is kept: one folder per company and year of emission */
export function authorizedXmlKey(tenantId: string, emissionYear: string, accessCode: string) {
  return `tenants/${tenantId}/invoices/${emissionYear}/${accessCode}.xml`;
}
