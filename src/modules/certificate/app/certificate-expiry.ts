import { logger } from '#/shared/logger';

import { daysLeft, EXPIRY_WINDOWS, ExpiryWindow, expiryWindow } from '../domain/certificate';
import { SelectedCertificate, SigningCertificates } from '../domain/repository';

export type ExpiryCounts = Record<ExpiryWindow, number>;

/**
 * The signing certificates of every company by expiry window (G-23): how many expired or expire
 * within 7 or 30 days. Only the certificate each issuer selected counts; one it replaced doesn't.
 */
export class CertificateExpiryReport {
  constructor(
    private readonly certificates: SigningCertificates,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async count(): Promise<ExpiryCounts> {
    const now = this.now();
    return countByWindow(await this.certificates.listSelected(), now);
  }

  /**
   * Counts them and logs each company whose certificate expired (`certificate.expired`, ERROR: its
   * documents wait) or expires within 30 days (`certificate.expiring`, WARN). The worker runs it
   * daily. Never the certificate's subject: it names a person
   */
  async report(): Promise<ExpiryCounts> {
    const now = this.now();
    const selected = await this.certificates.listSelected();
    for (const certificate of selected) {
      const window = expiryWindow(certificate.validTo, now);
      if (window) log(certificate, window, now);
    }
    return countByWindow(selected, now);
  }
}

function countByWindow(certificates: SelectedCertificate[], now: Date): ExpiryCounts {
  const counts = Object.fromEntries(EXPIRY_WINDOWS.map((window) => [window, 0])) as ExpiryCounts;
  for (const { validTo } of certificates) {
    const window = expiryWindow(validTo, now);
    if (window) counts[window] += 1;
  }
  return counts;
}

function log(
  { tenantId, certificateId, validTo }: SelectedCertificate,
  window: ExpiryWindow,
  now: Date,
) {
  const fields = {
    'faclab.tenant.id': tenantId,
    window,
    certificateId,
    validTo,
    daysLeft: daysLeft(validTo, now),
  };
  const date = validTo.toISOString().slice(0, 10);
  if (window === 'expired') {
    logger.error(
      { 'event.name': 'certificate.expired', ...fields },
      `The signing certificate of the company expired on ${date}: its documents wait until it ` +
        'uploads a new one and selects it in its fiscal profile',
    );
    return;
  }
  logger.warn(
    { 'event.name': 'certificate.expiring', ...fields },
    `The signing certificate of the company expires in ${fields.daysLeft} days (${date}): it ` +
      'must upload a new one and select it in its fiscal profile before then',
  );
}
