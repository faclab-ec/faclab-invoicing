import { Environment } from '#/modules/company-config/domain/company-config';

import { SriAuthorizationPort } from '../../domain/ports';
import { AuthorizationVoucher, AuthorizationVoucherStatus } from '../../domain/voucher';
import {
  authorizationErrorCode,
  authorizationState,
  AuthorizationVoucherResponseDTO,
  mapAuthorizationVoucherToDomain,
} from '../mappers/sri-authorization.mapper';
import { callSri } from './sri-call';
import { SriClients } from './sri-clients';

export class SriAuthorizationAdapter implements SriAuthorizationPort {
  constructor(private clients: SriClients) {}

  async authorizeXml(code: string, environment: Environment): Promise<AuthorizationVoucher> {
    const client = this.clients.authorization(environment);
    return callSri(
      {
        operation: 'autorizacion',
        environment,
        client,
        method: 'autorizacionComprobante',
        args: { claveAccesoComprobante: code },
      },
      (response: { RespuestaAutorizacionComprobante: AuthorizationVoucherResponseDTO }) => {
        const dto = response.RespuestaAutorizacionComprobante;
        const voucher = mapAuthorizationVoucherToDomain(dto);
        return {
          result: voucher,
          status: authorizationState(dto),
          rejectionCode:
            voucher.status === AuthorizationVoucherStatus.REJECTED
              ? authorizationErrorCode(dto)
              : undefined,
        };
      },
    );
  }
}
