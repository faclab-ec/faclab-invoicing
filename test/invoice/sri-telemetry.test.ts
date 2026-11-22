import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';

import { Environment } from '#/modules/company-config/domain/company-config';
import { IssuerNotReadyError } from '#/modules/company-config/domain/readiness';
import { VoucherType } from '#/modules/company-config/domain/sequence';
import { buildInvoiceXml } from '#/modules/invoice/domain/invoice-xml-builder';
import { InvoiceIssueError } from '#/modules/invoice/domain/issue';
import {
  AuthorizationVoucherStatus,
  ValidationVoucherStatus,
} from '#/modules/invoice/domain/voucher';
import { SriAuthorizationAdapter } from '#/modules/invoice/infra/adapters/sri-authorization.adapter';
import { rejectionCodeLabel } from '#/modules/invoice/infra/adapters/sri-call';
import { SriValidationAdapter } from '#/modules/invoice/infra/adapters/sri-validation.adapter';
import { SoapTimeoutError } from '#/shared/infra/soap-client';

import {
  fullInvoiceXmlInput,
  makeCertificate,
  makeConfig,
  readinessStub,
  realSigner,
  sriAnswering,
  TEST_ACCESS_CODE,
} from '../helpers';
import { useRecordedMetrics } from '../metrics';
import { useSpans } from '../tracing';

const { finished, reset } = useSpans();

const recorded = useRecordedMetrics();

const message = (identificador: string, tipo = 'ERROR') => ({
  identificador,
  mensaje: 'MENSAJE',
  informacionAdicional: 'detalle',
  tipo,
});

const reception =
  (estado: 'RECIBIDA' | 'DEVUELTA', mensajes: ReturnType<typeof message>[] = []) =>
  async () => ({
    RespuestaRecepcionComprobante: {
      estado,
      comprobantes: {
        comprobante: [{ claveAcceso: TEST_ACCESS_CODE, mensajes: { mensaje: mensajes } }],
      },
    },
  });

const authorization =
  (
    estado?: 'AUTORIZADO' | 'NO AUTORIZADO' | 'EN PROCESO',
    mensajes: ReturnType<typeof message>[] = [],
  ) =>
  async () => ({
    RespuestaAutorizacionComprobante: {
      claveAccesoConsultada: TEST_ACCESS_CODE,
      numeroComprobantes: '1',
      autorizaciones: estado
        ? {
            autorizacion: [
              {
                estado,
                numeroAutorizacion: TEST_ACCESS_CODE,
                fechaAutorizacion: '2026-11-21T10:00:00-05:00',
                ambiente: 'PRUEBAS',
                comprobante: '<factura/>',
                mensajes: { mensaje: mensajes },
              },
            ],
          }
        : undefined,
    },
  });

const DURATION = 'faclab.sri.request.duration';
const REJECTIONS = 'faclab.invoices.rejections';
const XML = '<factura id="comprobante"><claveAcceso>x</claveAcceso></factura>';

/** No attribute of the span carries the XML, its base64 nor the access code */
function expectNoDocumentData(attributes: Record<string, unknown>) {
  const xmlBase64 = Buffer.from(XML).toString('base64');
  for (const value of Object.values(attributes)) {
    expect(String(value)).not.toContain(TEST_ACCESS_CODE);
    expect(String(value)).not.toContain(xmlBase64);
    expect(String(value)).not.toContain('<factura');
  }
}

describe('SRI reception telemetry', () => {
  it('traces the call in sri.recepcion with the answer, and measures it', async () => {
    const adapter = new SriValidationAdapter(sriAnswering(reception('RECIBIDA')));

    const voucher = await adapter.validateXml(XML, Environment.TESTING);

    expect(voucher.status).toBe(ValidationVoucherStatus.ACCEPTED);
    const span = finished('sri.recepcion');
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes).toMatchObject({
      'rpc.system': 'soap',
      'rpc.method': 'validarComprobante',
      'server.address': 'celcer.sri.gob.ec',
      'faclab.sri.environment': 'pruebas',
      'faclab.sri.status': 'RECIBIDA',
    });
    expectNoDocumentData(span.attributes);
    const points = await recorded.collect();
    expect(
      points.total(DURATION, {
        'faclab.sri.operation': 'recepcion',
        'faclab.sri.outcome': 'ok',
        'faclab.sri.environment': 'pruebas',
      }),
    ).toBe(1);
    expect(points.total(REJECTIONS)).toBe(0);
  });

  it('counts a returned document by the code of its first error', async () => {
    const adapter = new SriValidationAdapter(
      sriAnswering(reception('DEVUELTA', [message('58', 'ADVERTENCIA'), message('35')])),
    );

    await adapter.validateXml(XML, Environment.PRODUCTION);

    expect(finished('sri.recepcion').attributes).toMatchObject({
      'faclab.sri.status': 'DEVUELTA',
      'faclab.sri.environment': 'produccion',
    });
    const points = await recorded.collect();
    expect(
      points.total(REJECTIONS, {
        'faclab.sri.message.code': '35',
        'faclab.sri.operation': 'recepcion',
      }),
    ).toBe(1);
  });

  it("doesn't count as a rejection what the SRI returns because it already has it", async () => {
    const adapter = new SriValidationAdapter(sriAnswering(reception('DEVUELTA', [message('43')])));

    const voucher = await adapter.validateXml(XML, Environment.TESTING);

    expect(voucher.alreadyReceived).toBe(true);
    expect((await recorded.collect()).total(REJECTIONS)).toBe(0);
  });

  it('tells a timeout from another failure, and leaves the invoice to retry', async () => {
    const slow = new SriValidationAdapter(
      sriAnswering(async () => {
        throw new SoapTimeoutError('SOAP validarComprobante', 30_000);
      }),
    );
    const broken = new SriValidationAdapter(
      sriAnswering(async () => {
        throw new Error('socket hang up');
      }),
    );

    await expect(slow.validateXml(XML, Environment.TESTING)).rejects.toMatchObject({
      code: 'SRI_UNAVAILABLE',
    });
    const timedOut = finished('sri.recepcion');
    reset();
    await expect(broken.validateXml(XML, Environment.TESTING)).rejects.toBeInstanceOf(
      InvoiceIssueError,
    );
    const failed = finished('sri.recepcion');

    expect(timedOut.status.code).toBe(SpanStatusCode.ERROR);
    expect(timedOut.attributes['error.type']).toBe('timeout');
    expect(failed.attributes['error.type']).toBe('Error');
    const points = await recorded.collect();
    expect(points.total(DURATION, { 'faclab.sri.outcome': 'timeout' })).toBe(1);
    expect(points.total(DURATION, { 'faclab.sri.outcome': 'error' })).toBe(1);
    expect(points.total(DURATION, { 'faclab.sri.outcome': 'ok' })).toBe(0);
  });
});

describe('SRI authorization telemetry', () => {
  it('traces sri.autorizacion with the answer and counts a rejection', async () => {
    const authorized = new SriAuthorizationAdapter(sriAnswering(authorization('AUTORIZADO')));
    const rejected = new SriAuthorizationAdapter(
      sriAnswering(authorization('NO AUTORIZADO', [message('52')])),
    );

    expect((await authorized.authorizeXml(TEST_ACCESS_CODE, Environment.TESTING)).status).toBe(
      AuthorizationVoucherStatus.AUTHORIZED,
    );
    const span = finished('sri.autorizacion');
    expect(span.attributes).toMatchObject({
      'rpc.method': 'autorizacionComprobante',
      'faclab.sri.status': 'AUTORIZADO',
    });
    expectNoDocumentData(span.attributes);
    reset();
    await rejected.authorizeXml(TEST_ACCESS_CODE, Environment.TESTING);
    expect(finished('sri.autorizacion').attributes['faclab.sri.status']).toBe('NO AUTORIZADO');

    const points = await recorded.collect();
    expect(points.total(DURATION, { 'faclab.sri.operation': 'autorizacion' })).toBe(2);
    expect(
      points.total(REJECTIONS, {
        'faclab.sri.message.code': '52',
        'faclab.sri.operation': 'autorizacion',
      }),
    ).toBe(1);
  });

  it('reports a voucher without an authorization yet as EN PROCESO', async () => {
    const adapter = new SriAuthorizationAdapter(sriAnswering(authorization()));

    const voucher = await adapter.authorizeXml(TEST_ACCESS_CODE, Environment.TESTING);

    expect(voucher.status).toBe(AuthorizationVoucherStatus.PROCESSING);
    expect(finished('sri.autorizacion').attributes['faclab.sri.status']).toBe('EN PROCESO');
    expect((await recorded.collect()).total(REJECTIONS)).toBe(0);
  });

  it('keeps the code of a rejection bounded', () => {
    expect(rejectionCodeLabel('35')).toBe('35');
    expect(rejectionCodeLabel(null)).toBe('none');
    expect(rejectionCodeLabel('12345')).toBe('other');
    expect(rejectionCodeLabel('CLAVE ACCESO REGISTRADA')).toBe('other');
  });
});

describe('Signing telemetry', () => {
  it('signs in an invoice.sign span with the type of the document', async () => {
    const signer = realSigner(
      readinessStub({ config: makeConfig(), certificate: makeCertificate() }),
    );
    const xml = buildInvoiceXml(fullInvoiceXmlInput());

    const signed = await signer.signInvoice(xml, 'tenant', VoucherType.CREDIT_NOTE);

    expect(signed).toContain('ds:Signature');
    const span = finished('invoice.sign');
    expect(span.attributes).toEqual({ 'faclab.document.type': 'credit_note' });
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('marks the span with the code of what kept it from signing', async () => {
    const signer = realSigner(
      readinessStub(new IssuerNotReadyError('CERTIFICATE_EXPIRED', 'expired')),
    );

    await expect(signer.signInvoice(XML, 'tenant', VoucherType.INVOICE)).rejects.toBeInstanceOf(
      IssuerNotReadyError,
    );

    const span = finished('invoice.sign');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes).toMatchObject({
      'faclab.document.type': 'invoice',
      'error.type': 'CERTIFICATE_EXPIRED',
    });
  });
});
