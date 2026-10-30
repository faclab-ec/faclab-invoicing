import { CompanyConfigRepository } from '#/modules/company-config/domain/repository';
import { logger } from '#/shared/logger';

import { buildInvoiceEmail } from '../../domain/invoice-email';
import { DocumentStorage, InvoiceMailer, MailRejectedError } from '../../domain/ports';
import { InvoiceDeliveryRepository, InvoiceRepository } from '../../domain/repository';
import { RideService } from './ride-service';

/**
 * Runs a delivery the worker took: makes sure the invoice has its RIDE and, when sending is on and
 * the buyer has an email, sends it the RIDE and the authorized XML. What the mail server answers
 * is recorded on the delivery (sent, bounced, or a failure retried later); only the storage or the
 * database throw, and the worker gives the delivery out again later.
 */
export class InvoiceDeliveryProcessor {
  constructor(
    private readonly deliveries: InvoiceDeliveryRepository,
    private readonly invoices: InvoiceRepository,
    private readonly rides: RideService,
    private readonly storage: DocumentStorage,
    private readonly companyConfigs: CompanyConfigRepository,
    // Null when sending is off (INVOICE_EMAIL_ENABLED=false): only the RIDE is kept
    private readonly mailer: InvoiceMailer | null,
    // The platform's sender address
    private readonly from: string | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(deliveryId: string): Promise<void> {
    const delivery = await this.deliveries.getById(deliveryId);
    if (!delivery?.isPending) return;
    const log = { deliveryId, invoiceId: delivery.invoiceId };

    const invoice = await this.invoices.getInvoiceById(delivery.invoiceId);
    const ride = invoice ? await this.rides.ensure(invoice) : null;
    const xmlKey = invoice?.authorization?.xmlKey;
    if (!ride || !xmlKey) {
      // Created with the authorization: it can only be an invoice authorized without its XML
      delivery.recordFailure('The invoice has no authorization to deliver', this.now());
      await this.deliveries.update(delivery);
      logger.error(log, 'Delivery of an invoice without its authorization');
      return;
    }

    if (!this.mailer || !this.from) {
      delivery.skip('disabled', this.now());
    } else if (!delivery.recipient) {
      delivery.skip('no_recipient', this.now());
    } else {
      const authorizedXml = await this.storage.getBytes(xmlKey);
      if (!authorizedXml) {
        delivery.recordFailure('The authorized XML is not in the document storage', this.now());
      } else {
        const replyTo = (await this.companyConfigs.find(delivery.tenantId))?.email ?? null;
        const mail = buildInvoiceEmail({
          ride: ride.ride,
          authorizedXml,
          pdf: ride.pdf,
          from: this.from,
          replyTo,
          to: delivery.recipient,
        });
        try {
          delivery.markSent(await this.mailer.send(mail), this.now());
        } catch (error) {
          if (error instanceof MailRejectedError) {
            delivery.markBounced(error.response, this.now());
          } else {
            const message = error instanceof Error ? error.message : String(error);
            delivery.recordFailure(message, this.now());
            // The server's text may carry the address: only its code goes to the log
            logger.warn(
              { ...log, code: (error as { code?: string }).code, attempts: delivery.attempts },
              'Sending the invoice failed',
            );
          }
        }
      }
    }
    await this.deliveries.update(delivery);
    logger.info(
      { ...log, status: delivery.status, attempts: delivery.attempts },
      'Invoice delivery',
    );
  }
}
