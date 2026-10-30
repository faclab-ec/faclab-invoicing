import { IssuerReadinessService } from '#/modules/company-config/app/issuer-readiness';
import { ConflictError, NotFoundError } from '#/shared/errors/app-error';

import { Invoice } from '../../domain/invoice';
import { InvoiceQueue } from '../../domain/queue';
import { InvoiceRepository } from '../../domain/repository';
import { InvoiceProcessor } from '../services/invoice-processor';
import { InvoiceRecoveryService } from '../services/invoice-recovery';

export interface RetryLease {
  // Who holds the invoice while the step runs (this process)
  holder: string;
  leaseMs: number;
}

/**
 * Runs the next step of one of the company's invoices now, ignoring its retry schedule. It holds
 * the invoice in the queue meanwhile, so no worker runs the same step at the same time; the worker
 * goes on with the next ones.
 */
export class RetryInvoiceCommand {
  constructor(
    private readonly invoiceRepository: InvoiceRepository,
    private readonly queue: InvoiceQueue,
    private readonly readiness: IssuerReadinessService,
    private readonly processor: InvoiceProcessor,
    private readonly lease: RetryLease,
  ) {}

  async execute(tenantId: string, id: string): Promise<Invoice> {
    const invoice = await this.invoiceRepository.findForTenant(tenantId, id);
    if (!invoice) throw new NotFoundError(`Invoice ${id} not found`);
    if (invoice.isFinal) {
      throw new ConflictError(
        'INVOICE_NOT_RETRYABLE',
        `Invoice ${id} is already ${invoice.status}`,
      );
    }

    const { holder, leaseMs } = this.lease;
    if (!(await this.queue.claim(id, holder, leaseMs))) {
      throw new ConflictError('INVOICE_IN_PROGRESS', `Invoice ${id} is being processed right now`);
    }
    try {
      // Check the issuer again instead of trusting the cached answer
      this.readiness.invalidate(tenantId);
      return (await this.processor.run(id, { maxSteps: 1 })) ?? invoice;
    } finally {
      await this.queue.release(id, holder);
    }
  }
}

/** Puts back in the queue every invoice of the company that needs attention */
export class RetryInvoicesCommand {
  constructor(
    private readonly readiness: IssuerReadinessService,
    private readonly recovery: InvoiceRecoveryService,
  ) {}

  /** How many invoices were queued */
  async execute(tenantId: string): Promise<number> {
    this.readiness.invalidate(tenantId);
    return this.recovery.run({ all: true, tenantId });
  }
}
