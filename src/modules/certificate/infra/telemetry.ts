import { certificatesExpiring, Point } from '#/shared/telemetry/metrics';

import { CertificateExpiryReport } from '../app/certificate-expiry';
import { EXPIRY_WINDOWS } from '../domain/certificate';

/**
 * Samples the signing certificates by expiry window: every window reports, at 0 if empty. It runs
 * with the other metrics, so a certificate renewed today stops counting right away; the daily log
 * is `CertificateExpiryReport.report`
 */
export async function sampleCertificates(
  report: CertificateExpiryReport,
  maxAgeMs: number,
): Promise<void> {
  const counts = await report.count();
  certificatesExpiring.replace(
    EXPIRY_WINDOWS.map((window): Point => [counts[window], { window }]),
    maxAgeMs,
  );
}
