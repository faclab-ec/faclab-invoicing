import { afterEach, describe, expect, it } from 'vitest';

import { CertificateExpiryReport } from '#/modules/certificate/app/certificate-expiry';
import { daysLeft, expiryWindow } from '#/modules/certificate/domain/certificate';
import { SelectedCertificate } from '#/modules/certificate/domain/repository';
import { sampleCertificates } from '#/modules/certificate/infra/telemetry';

import { TENANT_A, TENANT_B } from '../helpers';
import { captureLogs, silenceLogs } from '../logs';
import { useRecordedMetrics } from '../metrics';

const recorded = useRecordedMetrics();

const NOW = new Date('2026-11-21T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const inDays = (days: number) => new Date(NOW.getTime() + days * DAY_MS);
const TENANT_C = '4d5e6f70-8192-4a3b-8c4d-5e6f70819203';
const TENANT_D = '5e6f7081-9203-4b4c-9d5e-6f7081920314';

const selected = (
  tenantId: string,
  validTo: Date,
  certificateId = `cert-${tenantId.slice(0, 4)}`,
) => ({ tenantId, certificateId, validTo }) satisfies SelectedCertificate;

/** A company whose certificate expires in 5 days, one in 20, one that expired and one in a year */
const report = () =>
  new CertificateExpiryReport(
    {
      listSelected: async () => [
        selected(TENANT_A, inDays(5)),
        selected(TENANT_B, inDays(20)),
        selected(TENANT_C, inDays(-2)),
        selected(TENANT_D, inDays(365)),
      ],
    },
    () => NOW,
  );

afterEach(silenceLogs);

describe('Expiry windows of a certificate', () => {
  it('puts each certificate in one window at most', () => {
    expect(expiryWindow(inDays(5), NOW)).toBe('7d');
    expect(expiryWindow(inDays(7), NOW)).toBe('7d');
    expect(expiryWindow(inDays(7.5), NOW)).toBe('30d');
    expect(expiryWindow(inDays(30), NOW)).toBe('30d');
    expect(expiryWindow(inDays(31), NOW)).toBeNull();
    expect(expiryWindow(NOW, NOW)).toBe('expired');
    expect(expiryWindow(inDays(-1), NOW)).toBe('expired');
    expect(daysLeft(inDays(5), NOW)).toBe(5);
    expect(daysLeft(inDays(-2), NOW)).toBe(-2);
  });
});

describe('Certificate expiry report', () => {
  it('counts the certificates by window: one that expires in 5 days is in 7d', async () => {
    expect(await report().count()).toEqual({ expired: 1, '7d': 1, '30d': 1 });
  });

  it('logs each company whose certificate expires or expired, without its subject', async () => {
    const logs = captureLogs();

    await report().report();

    const entries = logs();
    expect(entries).toHaveLength(3);
    const soon = entries.find((entry) => entry['faclab.tenant.id'] === TENANT_A)!;
    expect(soon).toMatchObject({
      level: 40,
      'event.name': 'certificate.expiring',
      window: '7d',
      daysLeft: 5,
      certificateId: `cert-${TENANT_A.slice(0, 4)}`,
    });
    expect(soon.msg).toContain('expires in 5 days (2026-11-26)');
    expect(entries.find((entry) => entry['faclab.tenant.id'] === TENANT_B)).toMatchObject({
      'event.name': 'certificate.expiring',
      window: '30d',
    });
    expect(entries.find((entry) => entry['faclab.tenant.id'] === TENANT_C)).toMatchObject({
      level: 50,
      'event.name': 'certificate.expired',
      window: 'expired',
    });
    // The one valid for a year is left alone; nobody's name goes to the log
    expect(entries.some((entry) => entry['faclab.tenant.id'] === TENANT_D)).toBe(false);
    for (const entry of entries) expect(JSON.stringify(entry)).not.toContain('CN=');
  });

  it('reports every window in faclab.certificates.expiring, at 0 when empty', async () => {
    await sampleCertificates(report(), 60_000);

    const points = await recorded.collect();
    const expiring = 'faclab.certificates.expiring';
    expect(points.total(expiring, { window: '7d' })).toBe(1);
    expect(points.total(expiring, { window: '30d' })).toBe(1);
    expect(points.total(expiring, { window: 'expired' })).toBe(1);

    await sampleCertificates(
      new CertificateExpiryReport({ listSelected: async () => [] }, () => NOW),
      60_000,
    );
    const empty = (await recorded.collect()).of(expiring);
    expect(empty.map((point) => [point.attributes.window, point.value]).sort()).toEqual([
      ['30d', 0],
      ['7d', 0],
      ['expired', 0],
    ]);
  });
});
