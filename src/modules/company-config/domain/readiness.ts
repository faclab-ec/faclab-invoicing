import { Environment } from './company-config';

// Problems that stop the issuer from invoicing: invoices wait until they are fixed
export const READINESS_ERROR_CODES = [
  'CONFIG_MISSING',
  'CONFIG_INVALID',
  'CERTIFICATE_NOT_SELECTED',
  'CERTIFICATE_NOT_FOUND',
  'CERTIFICATE_EXPIRED',
  'CERTIFICATE_UNREADABLE',
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

/** Told when the config or the certificates change, so readiness is checked again */
export interface IssuerChangeListener {
  issuerChanged(): void;
}
