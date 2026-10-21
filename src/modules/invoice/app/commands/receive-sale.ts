import { v5 as uuidv5 } from 'uuid';

import { logger } from '#/shared/logger';

import { Invoice } from '../../domain/invoice';
import { InvoiceRepository } from '../../domain/repository';
import { SaleConfirmedMessage } from '../../infra/messaging/schemas';

// Fixed namespace: the same `sales.confirmed` event always maps to the same invoice id
const INVOICE_ID_NAMESPACE = '1184441d-77e9-413e-9b60-314f27a557e0';

export function invoiceIdForEvent(eventId: string): string {
  return uuidv5(eventId, INVOICE_ID_NAMESPACE);
}

/**
 * Stores the sale as a `pending` invoice, whether or not the issuer can invoice
 * yet: nothing is lost while the config or the certificate are missing.
 *
 * Kafka may deliver the same message twice (same event id, same invoice id). A
 * resend from faclab-core brings a new event id: it only creates an invoice if
 * the sale has none, or only rejected ones.
 */
export class ReceiveSaleCommand {
  constructor(private invoiceRepository: InvoiceRepository) {}

  async execute(message: SaleConfirmedMessage): Promise<Invoice | null> {
    const id = invoiceIdForEvent(message.event_id);
    const saleId = String(message.payload.sale_id);

    if (await this.invoiceRepository.getInvoiceById(id)) {
      logger.info({ invoiceId: id, saleId }, 'Sale already received, ignoring');
      return null;
    }

    const invoices = await this.invoiceRepository.findBySaleId(saleId);
    const active = invoices.find((invoice) => invoice.isActive);
    if (active) {
      logger.warn(
        { saleId, invoiceId: active.id, status: active.status },
        'Sale already has an active invoice, ignoring',
      );
      return null;
    }

    const invoice = Invoice.receive(id, message.payload);
    // A concurrent delivery or resend may have stored its invoice since the checks above
    if (!(await this.invoiceRepository.createInvoice(invoice))) {
      logger.info(
        { invoiceId: id, saleId },
        'Sale already received or with an active invoice, ignoring',
      );
      return null;
    }

    logger.info({ invoiceId: id, saleId }, 'Sale received for invoicing');
    return invoice;
  }
}
