import { IssuerReadinessService } from '#/modules/company-config/app/issuer-readiness';
import { ConflictError, NotFoundError } from '#/shared/errors/app-error';
import { logger } from '#/shared/logger';

import { Invoice } from '../../domain/invoice';
import { InvoiceRepository } from '../../domain/repository';
import { InvoiceEventHandler } from '../handlers/invoice-event.handler';
import { InvoiceRecoveryService } from '../services/invoice-recovery';

/** Runs the next step of one of the company's invoices now, ignoring its retry schedule */
export class RetryInvoiceCommand {
  constructor(
    private readonly invoiceRepository: InvoiceRepository,
    private readonly readiness: IssuerReadinessService,
    private readonly eventHandler: InvoiceEventHandler,
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

    // Check the issuer again instead of trusting the cached answer
    this.readiness.invalidate(tenantId);
    return (await this.eventHandler.process(id)) ?? invoice;
  }
}

/** Retries every invoice of the company that needs attention, in the background */
export class RetryInvoicesCommand {
  constructor(
    private readonly invoiceRepository: InvoiceRepository,
    private readonly readiness: IssuerReadinessService,
    private readonly recovery: InvoiceRecoveryService,
  ) {}

  /** How many invoices were queued */
  async execute(tenantId: string): Promise<number> {
    const { needingAttention } = await this.invoiceRepository.countInFlight(tenantId);

    this.readiness.invalidate(tenantId);
    this.recovery
      .run({ all: true, tenantId })
      .catch((error) => logger.error({ err: error }, 'Retrying invoices failed'));
    return needingAttention;
  }
}
