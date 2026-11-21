import {
  AuthorizationVoucher,
  AuthorizationVoucherStatus,
  AuthorizedVoucher,
} from '../../domain/voucher';
import { firstErrorCode, SriMessageDTO as MessageDTO } from './sri-message';

interface AuthorizationDTO {
  estado: 'AUTORIZADO' | 'NO AUTORIZADO' | 'EN PROCESO';
  numeroAutorizacion?: string;
  // strong-soap may hand back the xsd:dateTime as a Date
  fechaAutorizacion: string | Date;
  ambiente: string;
  comprobante: string;
  mensajes?: {
    mensaje: MessageDTO[];
  };
}

export interface AuthorizationVoucherResponseDTO {
  claveAccesoConsultada: string;
  numeroComprobantes: string;
  autorizaciones?: {
    autorizacion: AuthorizationDTO[];
  };
}

function mapAuthorizationStatus(status: string): AuthorizationVoucherStatus {
  switch (status) {
    case 'AUTORIZADO':
      return AuthorizationVoucherStatus.AUTHORIZED;
    case 'NO AUTORIZADO':
      return AuthorizationVoucherStatus.REJECTED;
    case 'EN PROCESO':
      return AuthorizationVoucherStatus.PROCESSING;
    default:
      throw new Error(`Not supported status: ${status}`);
  }
}

function authorizedVoucher(authorization: AuthorizationDTO): AuthorizedVoucher | null {
  const { numeroAutorizacion, fechaAutorizacion, comprobante } = authorization;
  if (!numeroAutorizacion || !fechaAutorizacion || !comprobante) return null;
  return {
    number: numeroAutorizacion,
    date:
      typeof fechaAutorizacion === 'string' ? fechaAutorizacion : fechaAutorizacion.toISOString(),
    environment: authorization.ambiente,
    voucherXml: comprobante,
  };
}

export function mapAuthorizationVoucherToDomain(
  dto: AuthorizationVoucherResponseDTO,
): AuthorizationVoucher {
  const authorization = dto.autorizaciones?.autorizacion?.[0];

  // No authorization yet: the SRI is still processing the voucher
  const status = authorization
    ? mapAuthorizationStatus(authorization.estado)
    : AuthorizationVoucherStatus.PROCESSING;
  return new AuthorizationVoucher(
    status,
    dto.claveAccesoConsultada,
    authorization?.fechaAutorizacion ? new Date(authorization.fechaAutorizacion) : null,
    authorization?.mensajes?.mensaje?.map(
      (m) => `${m.tipo} ${m.identificador} : ${m.mensaje} : ${m.informacionAdicional}`,
    ) ?? [],
    authorization && status === AuthorizationVoucherStatus.AUTHORIZED
      ? authorizedVoucher(authorization)
      : null,
  );
}

/** What the SRI said of the voucher; without an authorization yet, it is still processing it */
export function authorizationState(dto: AuthorizationVoucherResponseDTO): string {
  return dto.autorizaciones?.autorizacion?.[0]?.estado ?? 'EN PROCESO';
}

/** The code of the SRI's first error in an authorization answer (null without messages) */
export function authorizationErrorCode(dto: AuthorizationVoucherResponseDTO): string | null {
  return firstErrorCode(dto.autorizaciones?.autorizacion?.[0]?.mensajes?.mensaje ?? []);
}
