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

describe('SRI authorization mapper: an authorized invoice', () => {
  const CODE = '0910202601179214100100110010010000000011234567812';
  const authorized = (fields: Record<string, unknown> = {}) =>
    mapAuthorizationVoucherToDomain({
      claveAccesoConsultada: CODE,
      numeroComprobantes: '1',
      autorizaciones: {
        autorizacion: [
          {
            estado: 'AUTORIZADO',
            numeroAutorizacion: CODE,
            fechaAutorizacion: '2026-10-09T10:01:02-05:00',
            ambiente: 'PRUEBAS',
            comprobante: '<factura id="comprobante">...</factura>',
            ...fields,
          },
        ],
      },
    });

  it('keeps the number, the date as the SRI wrote it and the voucher it authorized', () => {
    const voucher = authorized();

    expect(voucher.status).toBe(AuthorizationVoucherStatus.AUTHORIZED);
    expect(voucher.authorizationDate).toEqual(new Date('2026-10-09T15:01:02Z'));
    expect(voucher.authorized).toEqual({
      number: CODE,
      date: '2026-10-09T10:01:02-05:00',
      environment: 'PRUEBAS',
      voucherXml: '<factura id="comprobante">...</factura>',
    });
  });

  it('takes the date when the SOAP client parsed it', () => {
    const voucher = authorized({ fechaAutorizacion: new Date('2026-10-09T15:01:02Z') });

    expect(voucher.authorized?.date).toBe('2026-10-09T15:01:02.000Z');
  });

  it('has nothing to keep without the number or the voucher', () => {
    expect(authorized({ numeroAutorizacion: undefined }).authorized).toBeNull();
    expect(authorized({ comprobante: '' }).authorized).toBeNull();
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
