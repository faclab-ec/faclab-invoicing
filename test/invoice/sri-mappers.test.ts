import { describe, expect, it } from 'vitest';

import {
  AuthorizationVoucherStatus,
  ValidationVoucherStatus,
} from '#/modules/invoice/domain/voucher';
import { mapAuthorizationVoucherToDomain } from '#/modules/invoice/infra/mappers/sri-authorization.mapper';
import { mapValidationVoucherToDomain } from '#/modules/invoice/infra/mappers/sri-validation.mapper';

const message = (identificador: string) => ({
  identificador,
  mensaje: 'mensaje',
  tipo: 'ERROR',
});

describe('SRI authorization mapper', () => {
  it('treats an answer without authorization as still processing', () => {
    const voucher = mapAuthorizationVoucherToDomain({
      claveAccesoConsultada: '123',
      numeroComprobantes: '0',
    });
    expect(voucher.status).toBe(AuthorizationVoucherStatus.PROCESSING);
  });

  it('maps EN PROCESO and NO AUTORIZADO', () => {
    const withState = (estado: 'EN PROCESO' | 'NO AUTORIZADO') =>
      mapAuthorizationVoucherToDomain({
        claveAccesoConsultada: '123',
        numeroComprobantes: '1',
        autorizaciones: {
          autorizacion: [{ estado, fechaAutorizacion: '', ambiente: 'PRUEBAS', comprobante: '' }],
        },
      }).status;

    expect(withState('EN PROCESO')).toBe(AuthorizationVoucherStatus.PROCESSING);
    expect(withState('NO AUTORIZADO')).toBe(AuthorizationVoucherStatus.REJECTED);
  });
});

describe('SRI reception mapper', () => {
  const returned = (...codes: string[]) =>
    mapValidationVoucherToDomain({
      estado: 'DEVUELTA',
      comprobantes: {
        comprobante: [{ claveAcceso: '123', mensajes: { mensaje: codes.map(message) } }],
      },
    });

  it('recognizes a voucher the SRI already has', () => {
    expect(returned('43').alreadyReceived).toBe(true);
    expect(returned('70').alreadyReceived).toBe(true);
  });

  it('keeps real rejections as rejections', () => {
    const voucher = returned('35', '43');
    expect(voucher.status).toBe(ValidationVoucherStatus.REJECTED);
    expect(voucher.alreadyReceived).toBe(false);
  });
});
