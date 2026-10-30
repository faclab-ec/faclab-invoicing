import { IssuerReadinessService } from '#/modules/company-config/app/issuer-readiness';
import { logger } from '#/shared/logger';

import { InvoiceResultEvent } from '../../domain/events';
import { Invoice, InvoiceStatus } from '../../domain/invoice';
import { isBlockingIssue, issueFromError } from '../../domain/issue';
import { MessageProducer } from '../../domain/ports';
import { InvoiceQueue } from '../../domain/queue';
import { ConcurrentUpdateError, InvoiceRepository } from '../../domain/repository';
import { InvoiceCommand } from '../commands/command';

// How long a result that couldn't be published waits before the queue gives it out again
const DEFAULT_PUBLISH_RETRY_MS = 60_000;

export interface ProcessOptions {
  // The lease the caller holds on the invoice, renewed after each step; without it, the caller
  // runs a single step it already holds the invoice for
  lease?: { holder: string; leaseMs: number };
  // Steps to run at most (a manual retry runs one); all of them by default
  maxSteps?: number;
}

/**
 * Moves an invoice through its steps (prepare, sign, send, authorize) by its stored status, until
 * it is final, a step fails or the lease is lost. The worker runs it for each invoice it takes from
 * the queue, and a manual retry for a single step.
 *
 * With a producer it also tells faclab-core the result (`invoices`) once the invoice is final, and
 * marks it published: if Kafka fails, the queue gives it out again later. Without one (the API), the
 * worker publishes it.
 */
export class InvoiceProcessor {
  constructor(
    private invoiceRepository: InvoiceRepository,
    private queue: InvoiceQueue,
    private commandMap: Map<InvoiceStatus, InvoiceCommand>,
    private readiness: IssuerReadinessService,
    private resultProducer: MessageProducer<InvoiceResultEvent> | null,
    private publishRetryMs: number = DEFAULT_PUBLISH_RETRY_MS,
    private now: () => Date = () => new Date(),
  ) {}

  /**
   * A failed step is recorded on the invoice (and retried later), not thrown: only storage errors
   * escape
   */
  async run(invoiceId: string, { lease, maxSteps = Infinity }: ProcessOptions = {}) {
    let invoice = await this.invoiceRepository.getInvoiceById(invoiceId);
    if (!invoice) {
      logger.warn({ invoiceId }, 'Invoice not found');
      return null;
    }

    for (let steps = 0; !invoice.isFinal && steps < maxSteps; steps++) {
      const advanced = await this.step(invoice);
      if (!advanced) {
        // From the stored invoice: the failed step may have changed the one in memory
        return this.invoiceRepository.getInvoiceById(invoiceId);
      }
      if (lease && !(await this.queue.renew(invoiceId, lease.holder, lease.leaseMs))) {
        logger.warn({ invoiceId }, 'Invoice lease lost, leaving it to its new holder');
        return invoice;
      }
    }

    if (invoice.isFinal && invoice.resultPublishedAt === null && this.resultProducer) {
      invoice = await this.publishResult(invoice);
    }
    return invoice;
  }

  /** Runs the invoice's next step: false if it failed or someone else moved the invoice */
  private async step(invoice: Invoice): Promise<boolean> {
    const command = this.commandMap.get(invoice.status);
    if (!command) {
      logger.warn({ invoiceId: invoice.id, status: invoice.status }, 'No command for status');
      return false;
    }

    // Released after its issuer changed, maybe by another process: don't trust an older answer
    if (invoice.issue && isBlockingIssue(invoice.issue.code) && invoice.nextAttemptAt) {
      this.readiness.invalidateIfOlder(invoice.tenantId, invoice.nextAttemptAt);
    }

    try {
      await command.execute(invoice);
      return true;
    } catch (error) {
      if (error instanceof ConcurrentUpdateError) {
        // Someone else moved it in the meantime
        logger.info({ invoiceId: invoice.id }, 'Invoice changed while processing, skipping');
        return false;
      }
      await this.recordIssue(invoice.id, error);
      return false;
    }
  }

  private async recordIssue(invoiceId: string, error: unknown): Promise<void> {
    const invoice = await this.invoiceRepository.getInvoiceById(invoiceId);
    if (!invoice || invoice.isFinal) return;

    const issue = issueFromError(error, this.now());
    invoice.recordIssue(issue);
    try {
      await this.invoiceRepository.updateInvoice(invoice);
    } catch (updateError) {
      if (updateError instanceof ConcurrentUpdateError) return;
      throw updateError;
    }

    logger.warn(
      {
        invoiceId,
        status: invoice.status,
        code: issue.code,
        reason: issue.message,
        attempts: invoice.attempts,
        nextAttemptAt: invoice.nextAttemptAt,
      },
      'Invoice step failed',
    );
  }

  private async publishResult(invoice: Invoice): Promise<Invoice> {
    try {
      await this.resultProducer!.sendMessage(invoice.resultEvent()!);
    } catch (error) {
      const retryAt = new Date(this.now().getTime() + this.publishRetryMs);
      logger.warn(
        { invoiceId: invoice.id, err: error, retryAt },
        'Invoice result not published, retrying later',
      );
      await this.queue.postpone(invoice.id, retryAt);
      return invoice;
    }

    invoice.markResultPublished(this.now());
    try {
      await this.invoiceRepository.updateInvoice(invoice);
    } catch (error) {
      // Published already: at worst it goes out once more (core ignores the repeat)
      if (!(error instanceof ConcurrentUpdateError)) throw error;
    }
    logger.info({ invoiceId: invoice.id, status: invoice.status }, 'Invoice result published');
    return invoice;
  }
}
