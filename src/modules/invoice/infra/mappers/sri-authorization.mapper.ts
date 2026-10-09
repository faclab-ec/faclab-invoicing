import { AuthorizationVoucher, AuthorizationVoucherStatus } from '../../domain/voucher';

interface MessageDTO {
  identificador: string;
  mensaje: string;
  informacionAdicional?: string;
  tipo: string;
}

interface AuthorizationDTO {
  estado: 'AUTORIZADO' | 'NO AUTORIZADO' | 'EN PROCESO';
  fechaAutorizacion: string;
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

export function mapAuthorizationVoucherToDomain(
  dto: AuthorizationVoucherResponseDTO,
): AuthorizationVoucher {
  const authorization = dto.autorizaciones?.autorizacion?.[0];

  // No authorization yet: the SRI is still processing the voucher
  return new AuthorizationVoucher(
    authorization
      ? mapAuthorizationStatus(authorization.estado)
      : AuthorizationVoucherStatus.PROCESSING,
    dto.claveAccesoConsultada,
    authorization?.fechaAutorizacion ? new Date(authorization.fechaAutorizacion) : null,
    authorization?.mensajes?.mensaje?.map(
      (m) => `${m.tipo} ${m.identificador} : ${m.mensaje} : ${m.informacionAdicional}`,
    ) ?? [],
  );
}
