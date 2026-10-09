import { describe, expect, it } from 'vitest';

import { IssuerNotReadyError } from '#/modules/company-config/domain/readiness';
import { AccessCode } from '#/modules/invoice/domain/access-code';
import { generateAccessCode } from '#/modules/invoice/domain/access-code-generator';
import { Invoice, InvoiceStatus } from '#/modules/invoice/domain/invoice';
import {
  InvoiceIssueError,
  issueFromError,
  MAX_AUTOMATIC_ATTEMPTS,
  nextAttemptAt,
} from '#/modules/invoice/domain/issue';

import { makeConfig, makeSale } from '../helpers';

const MINUTE = 60_000;
const ACCESS_CODE = '0910202601179214100100120010010000000420000004213';

function preparedInvoice(): Invoice {
  const invoice = Invoice.receive('inv-1', makeSale());
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
    const invoice = Invoice.receive('inv-1', makeSale());

    expect(invoice.status).toBe(InvoiceStatus.PENDING);
    expect(invoice.saleId).toBe('42');
    expect(invoice.accessCode).toBeNull();
    expect(invoice.needsAttention).toBe(true);
    expect(invoice.pullEvents().map((e) => e.type)).toEqual(['InvoiceReceived']);
  });

  it('needs a sequence before building the XML, and keeps it', () => {
    const invoice = Invoice.receive('inv-1', makeSale());
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

    invoice.reject(['DEVUELTA']);

    expect(invoice.isActive).toBe(false);
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
});

describe('generateAccessCode', () => {
  it('uses the Ecuador date, whatever the server time zone', () => {
    // 2026-10-10 03:00 UTC is still the 9th in Ecuador
    const code = generateAccessCode(
      new Date('2026-10-10T03:00:00Z'),
      makeConfig(),
      42,
      '000000001',
    );
    expect(code.slice(0, 8)).toBe('09102026');
    expect(code).toHaveLength(49);
  });
});
