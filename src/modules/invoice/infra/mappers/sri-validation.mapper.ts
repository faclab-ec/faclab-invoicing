import { ValidationVoucher, ValidationVoucherStatus } from '../../domain/voucher';

interface MessageDTO {
  identificador: string;
  mensaje: string;
  informacionAdicional?: string;
  tipo: string;
}

interface VoucherDTO {
  claveAcceso: string;
  mensajes?: {
    mensaje: MessageDTO[];
  };
}

export interface ReceiptVoucherResponseDTO {
  estado: 'RECIBIDA' | 'DEVUELTA';
  comprobantes?: {
    comprobante: VoucherDTO[];
  };
}

// SRI reception errors that mean the voucher is already there: 43 "CLAVE ACCESO
// REGISTRADA" and 70 "CLAVE DE ACCESO EN PROCESAMIENTO"
const ALREADY_RECEIVED_CODES = new Set(['43', '70']);

function mapValidationStatus(status: string): ValidationVoucherStatus {
  switch (status) {
    case 'RECIBIDA':
      return ValidationVoucherStatus.ACCEPTED;
    case 'DEVUELTA':
      return ValidationVoucherStatus.REJECTED;
    default:
      throw new Error(`Not supported status: ${status}`);
  }
}

export function mapValidationVoucherToDomain(dto: ReceiptVoucherResponseDTO): ValidationVoucher {
  const voucher = dto.comprobantes?.comprobante?.[0];
  const messages = voucher?.mensajes?.mensaje ?? [];
  const status = mapValidationStatus(dto.estado);

  return new ValidationVoucher(
    status,
    voucher?.claveAcceso ?? null,
    messages.map((m) => `${m.tipo} ${m.identificador} : ${m.mensaje} : ${m.informacionAdicional}`),
    status === ValidationVoucherStatus.REJECTED &&
      messages.length > 0 &&
      messages.every((m) => ALREADY_RECEIVED_CODES.has(String(m.identificador))),
  );
}
