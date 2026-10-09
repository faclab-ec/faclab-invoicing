import { IssuerReadinessService } from '#/modules/company-config/app/issuer-readiness';
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
}

/**
 * Moves forward the invoices the Kafka flow left behind:
 * - waiting for the issuer (config, certificate), once it is ready;
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

  private async runOnce({ all = false }: RecoveryRunOptions): Promise<number> {
    const { ready } = await this.readiness.check();
    const now = this.now();
    const due = (await this.invoiceRepository.findInFlight())
      .filter((invoice) => this.isDue(invoice, ready, now, all))
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
      logger.info({ due: due.length, processed, issuerReady: ready }, 'Invoice recovery run');
    }
    return processed;
  }

  private isDue(invoice: Invoice, issuerReady: boolean, now: Date, all: boolean): boolean {
    const { issue } = invoice;
    if (issue) {
      if (isBlockingIssue(issue.code)) return issuerReady;
      if (all) return true;
      return invoice.nextAttemptAt !== null && invoice.nextAttemptAt <= now;
    }
    // No issue: Kafka is moving it, unless it has been still for too long
    return now.getTime() - invoice.updatedAt.getTime() >= this.staleAfterMs;
  }
}
