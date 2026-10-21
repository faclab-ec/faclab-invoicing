import { IssuerReadinessService } from '#/modules/company-config/app/issuer-readiness';
import { ReadinessReport } from '#/modules/company-config/domain/readiness';
import { logger } from '#/shared/logger';

import { Invoice } from '../../domain/invoice';
import { isBlockingIssue } from '../../domain/issue';
import { InvoiceRepository } from '../../domain/repository';
import { InvoiceEventHandler } from '../handlers/invoice-event.handler';

// An invoice with no issue that hasn't moved for this long lost its event
const DEFAULT_STALE_AFTER_MS = 5 * 60_000;

export interface RecoveryRunOptions {
  // Manual "retry all": also invoices waiting for their next attempt or past
  // the automatic attempt limit
  all?: boolean;
  // Only this company's invoices
  tenantId?: string;
}

/**
 * Moves forward the invoices the Kafka flow left behind, of every company:
 * - waiting for their issuer (config, certificate), once it is ready: each company's issuer
 *   on its own, so one that can't invoice doesn't hold back another;
 * - failed for a transient reason, when their next attempt is due;
 * - stuck without an issue (event lost, crash), after a while.
 *
 * Runs on a timer, after a config or certificate change and on demand. Assumes
 * a single instance of the service; two would only waste work (the version
 * check keeps them from overwriting each other).
 */
export class InvoiceRecoveryService {
  private running: Promise<number> | null = null;

  constructor(
    private invoiceRepository: InvoiceRepository,
    private readiness: IssuerReadinessService,
    private eventHandler: InvoiceEventHandler,
    private staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
    private now: () => Date = () => new Date(),
  ) {}

  /** Number of invoices processed. Runs one at a time: a call waits for the current run */
  async run(options: RecoveryRunOptions = {}): Promise<number> {
    while (this.running) {
      await this.running.catch(() => undefined);
    }
    const run = this.runOnce(options);
    this.running = run;
    try {
      return await run;
    } finally {
      this.running = null;
    }
  }

  private async runOnce({ all = false, tenantId }: RecoveryRunOptions): Promise<number> {
    const now = this.now();
    const inFlight = (await this.invoiceRepository.findInFlight()).filter(
      (invoice) => tenantId === undefined || invoice.tenantId === tenantId,
    );
    // Only the issuers of the companies with invoices in flight, once each
    const reports = new Map<string, ReadinessReport>();
    for (const invoice of inFlight) {
      if (!reports.has(invoice.tenantId)) {
        reports.set(invoice.tenantId, await this.readiness.check(invoice.tenantId));
      }
    }
    const due = inFlight
      .filter((invoice) => this.isDue(invoice, reports.get(invoice.tenantId)!, now, all))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    let processed = 0;
    for (const invoice of due) {
      try {
        await this.eventHandler.process(invoice.id);
        processed += 1;
      } catch (error) {
        logger.error({ invoiceId: invoice.id, err: error }, 'Invoice recovery failed');
      }
    }
    if (due.length > 0) {
      const notReady = [...reports].filter(([, report]) => !report.ready).map(([id]) => id);
      logger.info(
        { due: due.length, processed, issuersNotReady: notReady },
        'Invoice recovery run',
      );
    }
    return processed;
  }

  private isDue(invoice: Invoice, issuer: ReadinessReport, now: Date, all: boolean): boolean {
    const { issue } = invoice;
    if (issue) {
      // Waits until the profile has the RUC the sale was made with, not just any change
      if (issue.code === 'ISSUER_RUC_MISMATCH') {
        return issuer.ready && issuer.taxId === invoice.point.issuerRuc;
      }
      if (isBlockingIssue(issue.code)) return issuer.ready;
      if (all) return true;
      return invoice.nextAttemptAt !== null && invoice.nextAttemptAt <= now;
    }
    // No issue: Kafka is moving it, unless it has been still for too long
    return now.getTime() - invoice.updatedAt.getTime() >= this.staleAfterMs;
  }
}
