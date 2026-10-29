import { describe, expect, it } from 'vitest';

import { Environment } from '#/modules/company-config/domain/company-config';
import { IssuerNotReadyError } from '#/modules/company-config/domain/readiness';
import { AccessCode } from '#/modules/invoice/domain/access-code';
import {
  generateAccessCode,
  generateNumericCode,
  mod11CheckDigit,
} from '#/modules/invoice/domain/access-code-generator';
import { Invoice, InvoiceStatus } from '#/modules/invoice/domain/invoice';
import {
  InvoiceInvalidError,
  InvoiceIssueError,
  issueFromError,
  MAX_AUTOMATIC_ATTEMPTS,
  nextAttemptAt,
} from '#/modules/invoice/domain/issue';

import { makeConfig, makePoint, makeSale } from '../helpers';

const MINUTE = 60_000;
const ACCESS_CODE = '0910202601179214100100120010010000000420000004213';

function preparedInvoice(): Invoice {
  const invoice = Invoice.receive('inv-1', makePoint(), makeSale());
  invoice.assignSequence('000000001');
  invoice.prepare({
    accessCode: AccessCode.create(ACCESS_CODE),
    signatureId: 'cert-1',
    xml: '<factura/>',
  });
  return invoice;
}

describe('Invoice', () => {
  it('starts pending with the sale and announces it', () => {
    const invoice = Invoice.receive('inv-1', makePoint(), makeSale());

    expect(invoice.status).toBe(InvoiceStatus.PENDING);
    expect(invoice.saleId).toBe('42');
    expect(invoice.accessCode).toBeNull();
    expect(invoice.needsAttention).toBe(true);
    expect(invoice.pullEvents().map((e) => e.type)).toEqual(['InvoiceReceived']);
  });

  it('needs a sequence before building the XML, and keeps it', () => {
    const invoice = Invoice.receive('inv-1', makePoint(), makeSale());
    expect(() =>
      invoice.prepare({
        accessCode: AccessCode.create(ACCESS_CODE),
        signatureId: 'cert-1',
        xml: '<factura/>',
      }),
    ).toThrow(/without a sequence/);

    invoice.assignSequence('000000001');
    expect(() => invoice.assignSequence('000000002')).toThrow(/already has sequence/);
  });

  it('gets the random numeric code of its access code with the sequence', () => {
    const invoice = Invoice.receive('inv-1', makePoint(), makeSale());
    expect(invoice.numericCode).toBeNull();

    invoice.assignSequence('000000001');

    expect(invoice.numericCode).toMatch(/^\d{8}$/);
    expect(invoice.requireNumericCode()).toBe(invoice.numericCode);
  });

  it('records an issue without changing status, and clears it on the next transition', () => {
    const invoice = preparedInvoice();
    const at = new Date('2026-10-09T15:00:00Z');

    invoice.recordIssue({ code: 'SRI_UNAVAILABLE', message: 'timeout', at });

    expect(invoice.status).toBe(InvoiceStatus.CREATED);
    expect(invoice.attempts).toBe(1);
    expect(invoice.nextAttemptAt).toEqual(new Date(at.getTime() + MINUTE));
    expect(invoice.needsAttention).toBe(true);

    invoice.sign('<factura firmada/>');

    expect(invoice.issue).toBeNull();
    expect(invoice.attempts).toBe(0);
    expect(invoice.nextAttemptAt).toBeNull();
    expect(invoice.needsAttention).toBe(false);
  });

  it('is active until rejected, and final once authorized or rejected', () => {
    const invoice = preparedInvoice();
    expect(invoice.isActive).toBe(true);

    invoice.reject(['DEVUELTA', 'CLAVE REPETIDA']);

    expect(invoice.isActive).toBe(false);
    expect(invoice.pullEvents().at(-1)).toMatchObject({
      type: 'InvoiceRejected',
      reason: 'DEVUELTA >> CLAVE REPETIDA',
    });
    expect(invoice.isFinal).toBe(true);
    expect(() =>
      invoice.recordIssue({ code: 'SRI_UNAVAILABLE', message: 'x', at: new Date() }),
    ).toThrow();
  });
});

describe('issues', () => {
  it('maps issuer, SRI and unknown errors', () => {
    const at = new Date();
    expect(issueFromError(new IssuerNotReadyError('CONFIG_MISSING', 'no config'), at).code).toBe(
      'CONFIG_MISSING',
    );
    expect(issueFromError(new InvoiceIssueError('SRI_PROCESSING', 'wait'), at).code).toBe(
      'SRI_PROCESSING',
    );
    expect(issueFromError(new InvoiceInvalidError('XML_SCHEMA_INVALID', 'bad'), at).code).toBe(
      'XML_SCHEMA_INVALID',
    );
    expect(issueFromError(new Error('boom'), at)).toEqual({
      code: 'UNEXPECTED_ERROR',
      message: 'boom',
      at,
    });
  });

  it('retries transient issues with a growing delay, up to a limit', () => {
    const now = new Date('2026-10-09T15:00:00Z');
    const delay = (attempts: number) =>
      (nextAttemptAt('SRI_UNAVAILABLE', attempts, now)?.getTime() ?? 0) - now.getTime();

    expect([1, 2, 3, 4, 5].map(delay)).toEqual([1, 5, 15, 60, 60].map((m) => m * MINUTE));
    expect(nextAttemptAt('SRI_UNAVAILABLE', MAX_AUTOMATIC_ATTEMPTS, now)).toBeNull();
  });

  it('never schedules issuer problems: they wait for the issuer', () => {
    expect(nextAttemptAt('CERTIFICATE_EXPIRED', 1, new Date())).toBeNull();
  });

  it('never schedules an invalid invoice: retrying gives the same result', () => {
    expect(nextAttemptAt('XML_SCHEMA_INVALID', 1, new Date())).toBeNull();
    expect(nextAttemptAt('INVOICE_DATA_INVALID', 1, new Date())).toBeNull();
  });
});

describe('generateAccessCode', () => {
  it('uses the Ecuador date, whatever the server time zone', () => {
    // 2026-10-10 03:00 UTC is still the 9th in Ecuador
    const code = generateAccessCode({
      date: new Date('2026-10-10T03:00:00Z'),
      taxId: makeConfig().taxId,
      environment: Environment.PRODUCTION,
      establishment: '001',
      emissionPoint: '001',
      sequence: '000000001',
      numericCode: '00000001',
    });
    expect(code.slice(0, 8)).toBe('09102026');
    expect(code).toHaveLength(49);
  });

  it("carries the issuer's RUC, environment, establishment, emission point and sequence", () => {
    const code = generateAccessCode({
      date: new Date('2026-10-09T15:00:00Z'),
      taxId: '0990012345001',
      environment: Environment.TESTING,
      establishment: '002',
      emissionPoint: '003',
      sequence: '000000041',
      numericCode: '73009952',
    });

    expect(code.slice(10, 23)).toBe('0990012345001');
    expect(code.slice(24, 39)).toBe('002003000000041');
    expect(code.slice(39, 47)).toBe('73009952');
    expect(AccessCode.create(code).environment).toBe(Environment.TESTING);
    expect(AccessCode.create(code).emissionYear).toBe('2026');
  });

  it('rebuilds an access code of the ficha técnica from its parts', () => {
    // Factura 001-002-000000067 of RUC 0503061798001 in production, 02/11/2024 (ficha técnica 2.34)
    const code = generateAccessCode({
      date: new Date('2024-11-02T15:00:00Z'),
      taxId: '0503061798001',
      environment: Environment.PRODUCTION,
      establishment: '001',
      emissionPoint: '002',
      sequence: '000000067',
      numericCode: '73009952',
    });

    expect(code).toBe('0211202401050306179800120010020000000677300995216');
  });

  it('refuses a numeric code that is not 8 digits', () => {
    const input = {
      date: new Date(),
      taxId: '1792104394001',
      environment: Environment.TESTING,
      establishment: '001',
      emissionPoint: '001',
      sequence: '000000009',
    };

    expect(() => generateAccessCode({ ...input, numericCode: '123456789' })).toThrow(/8 digits/);
    expect(() => generateAccessCode({ ...input, numericCode: '42' })).toThrow(/8 digits/);
  });

  it('draws random numeric codes of 8 digits', () => {
    const codes = Array.from({ length: 50 }, generateNumericCode);

    expect(codes.every((code) => /^\d{8}$/.test(code))).toBe(true);
    expect(new Set(codes).size).toBeGreaterThan(1);
  });
});

describe('mod11CheckDigit', () => {
  it('follows the example of the ficha técnica', () => {
    expect(mod11CheckDigit('41261533')).toBe(6);
  });

  // Access codes printed in the ficha técnica 2.34. One more there,
  // 2111202401176001321000110010010000011171234567810, has a check digit that doesn't match
  it.each([
    '2111202405176001321000110010010000001241234567810',
    '1702201205176001321000110010030001000011234567816',
    '2808201400179210439400110010010000000091234567812',
    '0211202401050306179800120010020000000677300995216',
    '1510202407099313057500110010010000103591234567816',
    '1211202401092554321700110021000000000790925543211',
    '1111202401099338176200110020010000003961234567815',
  ])('matches the check digit of %s', (code) => {
    expect(mod11CheckDigit(code.slice(0, 48))).toBe(Number(code[48]));
  });
});
