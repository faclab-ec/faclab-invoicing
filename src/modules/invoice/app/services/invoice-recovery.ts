import { IssuerReadinessService } from '#/modules/company-config/app/issuer-readiness';
import { ReadinessReport } from '#/modules/company-config/domain/readiness';
import { logger } from '#/shared/logger';

import { isBlockingIssue } from '../../domain/issue';
import { InvoiceQueue, WaitingInvoice } from '../../domain/queue';

export interface RecoveryRunOptions {
  // Manual "retry all": also invoices waiting for their next attempt, invalid ones and those past
  // the automatic attempt limit
  all?: boolean;
  // Only this company's invoices
  tenantId?: string;
}

/**
 * Puts back in the queue the invoices that wait for something other than a date, of every company:
 * - waiting for their issuer (config, certificate), once it is ready: each company's issuer on its
 *   own, so one that can't invoice doesn't hold back another;
 * - with "retry all", also the transient issues not yet due, the invalid invoices and those past
 *   the automatic limit;
 * - in flight with no date and no issue (left by an older version), always.
 *
 * It only sets their next attempt: a worker runs them. Runs in the worker on a timer, in the API
 * after a config or certificate change and on demand; two runs at once only repeat an update.
 */
export class InvoiceRecoveryService {
  constructor(
    private queue: InvoiceQueue,
    private readiness: IssuerReadinessService,
    private now: () => Date = () => new Date(),
  ) {}

  /** How many invoices were put back in the queue */
  async run({ all = false, tenantId }: RecoveryRunOptions = {}): Promise<number> {
    const waiting = await this.queue.findWaiting(tenantId);
    // Only the issuers of the companies with invoices waiting for them, once each and freshly:
    // the change may have been saved by another process
    const reports = new Map<string, ReadinessReport>();
    for (const invoice of waiting) {
      if (waitsForIssuer(invoice) && !reports.has(invoice.tenantId)) {
        this.readiness.invalidate(invoice.tenantId);
        reports.set(invoice.tenantId, await this.readiness.check(invoice.tenantId));
      }
    }
    const due = waiting.filter((invoice) => isDue(invoice, reports.get(invoice.tenantId), all));
    if (due.length === 0) return 0;

    const released = await this.queue.requeue(
      due.map((invoice) => invoice.id),
      this.now(),
    );
    const notReady = [...reports].filter(([, report]) => !report.ready).map(([id]) => id);
    logger.info({ released, issuersNotReady: notReady }, 'Invoices put back in the queue');
    return released;
  }
}

function waitsForIssuer({ issueCode }: WaitingInvoice): boolean {
  return issueCode !== null && isBlockingIssue(issueCode);
}

function isDue(invoice: WaitingInvoice, issuer: ReadinessReport | undefined, all: boolean) {
  const { issueCode } = invoice;
  // No issue and no date: nothing would ever take it
  if (issueCode === null) return invoice.nextAttemptAt === null || all;
  // Waits until the profile has the RUC the sale was made with, not just any change
  if (issueCode === 'ISSUER_RUC_MISMATCH') {
    return issuer!.ready && issuer!.taxId === invoice.issuerRuc;
  }
  if (isBlockingIssue(issueCode)) return issuer!.ready;
  return all;
}
