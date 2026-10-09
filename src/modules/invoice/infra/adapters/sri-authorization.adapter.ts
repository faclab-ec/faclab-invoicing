import { SoapClient } from '#/shared/infra/soap-client';

import { InvoiceIssueError } from '../../domain/issue';
import { SriAuthorizationPort } from '../../domain/ports';
import { AuthorizationVoucher } from '../../domain/voucher';
import {
  AuthorizationVoucherResponseDTO,
  mapAuthorizationVoucherToDomain,
} from '../mappers/sri-authorization.mapper';

export class SriAuthorizationAdapter implements SriAuthorizationPort {
  constructor(private authorizationClient: SoapClient) {}

  async authorizeXml(code: string): Promise<AuthorizationVoucher> {
    let response: { RespuestaAutorizacionComprobante: AuthorizationVoucherResponseDTO };
    try {
      response = (await this.authorizationClient.callMethod('autorizacionComprobante', {
        claveAccesoComprobante: code,
      })) as typeof response;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new InvoiceIssueError('SRI_UNAVAILABLE', `SRI authorization service failed: ${reason}`);
    }
    return mapAuthorizationVoucherToDomain(response.RespuestaAutorizacionComprobante);
  }
}
