import { v5 as uuidv5 } from 'uuid';

import { logger } from '#/shared/logger';

import { Invoice, TraceContext } from '../../domain/invoice';
import { ConcurrentUpdateError, InvoiceRepository } from '../../domain/repository';
import { IssuingPoint, SaleData } from '../../domain/sale';

// Fixed namespace: the same `sales.confirmed` event always maps to the same invoice id
const INVOICE_ID_NAMESPACE = '1184441d-77e9-413e-9b60-314f27a557e0';

export function invoiceIdForEvent(eventId: string): string {
  return uuidv5(eventId, INVOICE_ID_NAMESPACE);
}

/** A `sales.confirmed` message of any version, with who issues and from where */
export interface ReceivedSale {
  eventId: string;
  point: IssuingPoint;
  sale: SaleData;
  // occurred_at of the message: when faclab-core asked to invoice it
  requestedAt: Date;
}

/**
 * Stores the sale as a `pending` invoice of its company, due right away, whether or not its issuer
 * can invoice yet: nothing is lost while the config or the certificate are missing. Nothing else
 * happens here: a worker takes it from the queue, so a slow SRI never holds back new sales.
 *
 * Kafka may deliver the same message twice (same event id, same invoice id). A
 * resend from faclab-core brings a new event id: it only creates an invoice if
 * the sale has none, or only rejected ones. If its invoice is already authorized,
 * the result is published again: faclab-core resends a sale that still waits for
 * it (S4.3), so the first one may never have reached it.
 */
export class ReceiveSaleCommand {
  constructor(
    private invoiceRepository: InvoiceRepository,
    // The trace of the message being handled, kept so the worker continues it
    private traceContext: () => TraceContext | null = () => null,
  ) {}

  async execute({ eventId, point, sale, requestedAt }: ReceivedSale): Promise<Invoice | null> {
    const id = invoiceIdForEvent(eventId);
    const saleId = String(sale.sale_id);
    const { tenantId } = point;

    if (await this.invoiceRepository.getInvoiceById(id)) {
      logger.info({ invoiceId: id, saleId }, 'Sale already received, ignoring');
      return null;
    }

    const invoices = await this.invoiceRepository.findBySaleId(tenantId, saleId);
    const active = invoices.find((invoice) => invoice.isActive);
    if (active) {
      if (active.publishResultAgain()) {
        await this.saveIgnoringConcurrent(active);
        logger.info(
          { saleId, invoiceId: active.id },
          'Sale already invoiced, publishing its result again',
        );
        return null;
      }
      logger.warn(
        { saleId, invoiceId: active.id, status: active.status },
        'Sale already has an active invoice, ignoring',
      );
      return null;
    }

    const invoice = Invoice.receive(id, point, sale, new Date(), requestedAt, this.traceContext());
    // A concurrent delivery or resend may have stored its invoice since the checks above
    if (!(await this.invoiceRepository.createInvoice(invoice))) {
      logger.info(
        { invoiceId: id, saleId },
        'Sale already received or with an active invoice, ignoring',
      );
      return null;
    }

    logger.info(
      {
        invoiceId: id,
        saleId,
        tenantId,
        establishment: point.establishment,
        emissionPoint: point.emissionPoint,
      },
      'Sale received for invoicing',
    );
    return invoice;
  }

  // The worker publishing the result meanwhile is enough: faclab-core gets it either way
  private async saveIgnoringConcurrent(invoice: Invoice): Promise<void> {
    try {
      await this.invoiceRepository.updateInvoice(invoice);
    } catch (error) {
      if (!(error instanceof ConcurrentUpdateError)) throw error;
    }
  }
}
