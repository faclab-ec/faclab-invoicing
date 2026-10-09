import { logger } from '#/shared/logger';

import { InvoiceDomainEvent } from '../../domain/events';
import { Invoice, InvoiceStatus } from '../../domain/invoice';
import { issueFromError } from '../../domain/issue';
import { MessageProducer } from '../../domain/ports';
import { ConcurrentUpdateError, InvoiceRepository } from '../../domain/repository';
import { InvoiceCommand } from '../commands/command';
import { InvoiceMessageInput } from '../types';

/**
 * Moves an invoice one step, by its stored status. The `invoices` topic, the
 * recovery job and the retry endpoints all go through `process`.
 */
export class InvoiceEventHandler {
  constructor(
    private invoiceRepository: InvoiceRepository,
    private commandMap: Map<InvoiceStatus, InvoiceCommand>,
    private messageProducer: MessageProducer<InvoiceDomainEvent>,
    private now: () => Date = () => new Date(),
  ) {}

  async handle(message: InvoiceMessageInput): Promise<void> {
    await this.process(message.invoiceId);
  }

  /**
   * A failed step is recorded on the invoice (and retried later), not thrown:
   * only storage or Kafka errors escape.
   */
  async process(invoiceId: string): Promise<Invoice | null> {
    const invoice = await this.invoiceRepository.getInvoiceById(invoiceId);
    if (!invoice) {
      logger.warn({ invoiceId }, 'Invoice not found');
      return null;
    }

    if (invoice.isFinal) {
      logger.debug({ invoiceId, status: invoice.status }, 'Invoice already processed');
      return invoice;
    }

    const command = this.commandMap.get(invoice.status);
    if (!command) {
      logger.warn({ invoiceId, status: invoice.status }, 'No command for status');
      return invoice;
    }

    try {
      await command.execute(invoice);
    } catch (error) {
      if (error instanceof ConcurrentUpdateError) {
        // Someone else moved it in the meantime
        logger.info({ invoiceId }, 'Invoice changed while processing, skipping');
        return this.invoiceRepository.getInvoiceById(invoiceId);
      }
      return this.recordIssue(invoiceId, error);
    }

    for (const event of invoice.pullEvents()) {
      await this.messageProducer.sendMessage(event);
    }
    return invoice;
  }

  private async recordIssue(invoiceId: string, error: unknown): Promise<Invoice | null> {
    // From the stored invoice: the failed step may have changed the one in memory
    const invoice = await this.invoiceRepository.getInvoiceById(invoiceId);
    if (!invoice || invoice.isFinal) return invoice;

    const issue = issueFromError(error, this.now());
    invoice.recordIssue(issue);
    try {
      await this.invoiceRepository.updateInvoice(invoice);
    } catch (updateError) {
      if (updateError instanceof ConcurrentUpdateError) {
        return this.invoiceRepository.getInvoiceById(invoiceId);
      }
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
    return invoice;
  }
}
