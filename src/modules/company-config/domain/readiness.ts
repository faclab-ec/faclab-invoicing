import { Environment } from './company-config';

// Problems that stop the issuer from invoicing: invoices wait until they are fixed
export const READINESS_ERROR_CODES = [
  'CONFIG_MISSING',
  'CONFIG_INVALID',
  // An issuer in the production environment where only the test one is reachable (local)
  'ENVIRONMENT_NOT_ALLOWED',
  'CERTIFICATE_NOT_SELECTED',
  'CERTIFICATE_NOT_FOUND',
  'CERTIFICATE_EXPIRED',
  'CERTIFICATE_UNREADABLE',
  // The selected certificate is not of the issuer's RUC
  'CERTIFICATE_RUC_MISMATCH',
  // The sale names a RUC other than the issuer's: one invoice waits until the profile is fixed
  'ISSUER_RUC_MISMATCH',
] as const;

export type ReadinessErrorCode = (typeof READINESS_ERROR_CODES)[number];

// Worth knowing, but invoices still go out
export type ReadinessWarningCode = 'CERTIFICATE_EXPIRING_SOON' | 'TEST_ENVIRONMENT';

export type ReadinessIssue =
  | { code: ReadinessErrorCode; severity: 'error'; message: string }
  | { code: ReadinessWarningCode; severity: 'warning'; message: string };

export interface ReadinessCertificate {
  id: string;
  subject: string;
  validTo: Date;
}

export interface ReadinessReport {
  ready: boolean;
  // The issuer's RUC, once its profile is saved
  taxId: string | null;
  environment: Environment | null;
  certificate: ReadinessCertificate | null;
  issues: ReadinessIssue[];
}

export function isReadinessErrorCode(code: string): code is ReadinessErrorCode {
  return (READINESS_ERROR_CODES as readonly string[]).includes(code);
}

/** The issuer can't invoice yet (missing config, unusable certificate...) */
export class IssuerNotReadyError extends Error {
  constructor(
    public readonly code: ReadinessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IssuerNotReadyError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Told when a company's config or certificates change, so its readiness is checked again */
export interface IssuerChangeListener {
  issuerChanged(tenantId: string): void;
}
