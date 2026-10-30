import { ConflictError, NotFoundError } from '#/shared/errors/app-error';
import { logger } from '#/shared/logger';

import { buyerEmail, InvoiceDelivery } from '../../domain/delivery';
import { TraceContext } from '../../domain/invoice';
import { InvoiceDeliveryRepository, InvoiceRepository } from '../../domain/repository';

/**
 * Sends an authorized invoice of the company to its buyer again: always to the buyer's email of
 * the sale, never to another address. While a delivery of the invoice is pending, answers that one.
 */
export class ResendInvoiceEmailCommand {
  constructor(
    private readonly invoices: InvoiceRepository,
    private readonly deliveries: InvoiceDeliveryRepository,
    // INVOICE_EMAIL_ENABLED
    private readonly emailEnabled: boolean,
    private readonly traceContext: () => TraceContext | null = () => null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(
    tenantId: string,
    invoiceId: string,
    requestedBy: string,
  ): Promise<InvoiceDelivery> {
    const invoice = await this.invoices.findForTenant(tenantId, invoiceId);
    if (!invoice) throw new NotFoundError('Invoice not found');
    if (!invoice.authorization) {
      throw new ConflictError('INVOICE_NOT_AUTHORIZED', 'Only an authorized invoice can be sent');
    }
    if (!this.emailEnabled) {
      throw new ConflictError('EMAIL_DISABLED', 'Sending invoices by email is turned off');
    }
    if (!buyerEmail(invoice.sale)) {
      throw new ConflictError('BUYER_EMAIL_MISSING', 'The buyer of the sale has no valid email');
    }
    const delivery = await this.deliveries.createResend(
      InvoiceDelivery.resend(invoice, requestedBy, this.now(), this.traceContext()),
    );
    logger.info({ invoiceId, deliveryId: delivery.id }, 'Invoice resend requested');
    return delivery;
  }
}
