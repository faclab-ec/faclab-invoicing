import {
  isReadinessErrorCode,
  IssuerNotReadyError,
  ReadinessErrorCode,
} from '#/modules/company-config/domain/readiness';

// Failures that may go away by themselves: retried with a growing delay
export type TransientIssueCode = 'SRI_UNAVAILABLE' | 'SRI_PROCESSING' | 'UNEXPECTED_ERROR';

/**
 * Why an invoice couldn't move to its next status. Issuer problems (config,
 * certificate) block it until they are fixed; the rest are retried.
 */
export type InvoiceIssueCode = ReadinessErrorCode | TransientIssueCode;

export interface InvoiceIssue {
  code: InvoiceIssueCode;
  message: string;
  at: Date;
}

/** A step failed for a reason worth retrying later */
export class InvoiceIssueError extends Error {
  constructor(
    public readonly code: TransientIssueCode,
    message: string,
  ) {
    super(message);
    this.name = 'InvoiceIssueError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const RETRY_DELAYS_MS = [1, 5, 15, 60].map((minutes) => minutes * 60_000);

// After this many attempts a transient issue is only retried by hand
export const MAX_AUTOMATIC_ATTEMPTS = 10;

export function isBlockingIssue(code: InvoiceIssueCode): boolean {
  return isReadinessErrorCode(code);
}

export function issueFromError(error: unknown, at: Date): InvoiceIssue {
  if (error instanceof IssuerNotReadyError || error instanceof InvoiceIssueError) {
    return { code: error.code, message: error.message, at };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'UNEXPECTED_ERROR', message, at };
}

/**
 * When to try again after `attempts` failed attempts. Blocking issues wait for
 * the issuer to be ready instead of a date; null also means "stop retrying".
 */
export function nextAttemptAt(code: InvoiceIssueCode, attempts: number, now: Date): Date | null {
  if (isBlockingIssue(code) || attempts >= MAX_AUTOMATIC_ATTEMPTS) return null;
  const step = Math.min(Math.max(attempts, 1), RETRY_DELAYS_MS.length);
  const delay = RETRY_DELAYS_MS[step - 1];
  return new Date(now.getTime() + delay);
}
