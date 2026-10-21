import { Environment } from '#/modules/company-config/domain/company-config';

import { InvoiceIssueError } from '../../domain/issue';
import { SriAuthorizationPort } from '../../domain/ports';
import { AuthorizationVoucher } from '../../domain/voucher';
import {
  AuthorizationVoucherResponseDTO,
  mapAuthorizationVoucherToDomain,
} from '../mappers/sri-authorization.mapper';
import { SriClients } from './sri-clients';

export class SriAuthorizationAdapter implements SriAuthorizationPort {
  constructor(private clients: SriClients) {}

  async authorizeXml(code: string, environment: Environment): Promise<AuthorizationVoucher> {
    const client = this.clients.authorization(environment);
    let response: { RespuestaAutorizacionComprobante: AuthorizationVoucherResponseDTO };
    try {
      response = (await client.callMethod('autorizacionComprobante', {
        claveAccesoComprobante: code,
      })) as typeof response;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new InvoiceIssueError('SRI_UNAVAILABLE', `SRI authorization service failed: ${reason}`);
    }
    return mapAuthorizationVoucherToDomain(response.RespuestaAutorizacionComprobante);
  }
}
