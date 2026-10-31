import { logger } from '#/shared/logger';

import { authorizedXmlKey, buildAuthorizedXml } from '../../domain/authorized-xml';
import { InvoiceDelivery } from '../../domain/delivery';
import { Invoice, TraceContext } from '../../domain/invoice';
import { InvoiceIssueError } from '../../domain/issue';
import { DocumentStorage, SriAuthorizationPort } from '../../domain/ports';
import { InvoiceRepository } from '../../domain/repository';
import { AuthorizationVoucherStatus } from '../../domain/voucher';
import { InvoiceCommand } from './command';

export class AuthorizeInvoiceCommand implements InvoiceCommand {
  constructor(
    private sriAuthorizationPort: SriAuthorizationPort,
    private invoiceRepository: InvoiceRepository,
    private documentStorage: DocumentStorage,
    // The trace the delivery continues: the step's own, in the worker
    private traceContext: () => TraceContext | null = () => null,
    private now: () => Date = () => new Date(),
  ) {}

  async execute(invoice: Invoice): Promise<void> {
    const code = invoice.requireAccessCode();
    const { value: accessCode, environment } = code;
    logger.info({ invoiceId: invoice.id, accessCode }, 'Authorizing invoice');
    // Where it was sent: the environment of its access code
    const authorizationVoucher = await this.sriAuthorizationPort.authorizeXml(
      accessCode,
      environment,
    );
    if (authorizationVoucher.status === AuthorizationVoucherStatus.PROCESSING) {
      // Not an answer yet: stays `sent` and is asked again later
      throw new InvoiceIssueError(
        'SRI_PROCESSING',
        'The SRI has not finished processing the invoice',
      );
    }
    if (authorizationVoucher.status === AuthorizationVoucherStatus.AUTHORIZED) {
      const authorized = authorizationVoucher.authorized;
      if (!authorized) {
        // Asked again later: the SRI keeps answering for the access code
        throw new InvoiceIssueError(
          'SRI_UNAVAILABLE',
          'The SRI authorized the invoice without its authorization number or voucher',
        );
      }
      // Kept before the invoice is marked: an authorized invoice always has its XML. If the
      // upload fails it stays `sent`, and the retry asks the SRI and uploads to the same key again
      const xmlKey = authorizedXmlKey(invoice.tenantId, code.emissionYear, accessCode);
      await this.documentStorage.put(xmlKey, buildAuthorizedXml(authorized), 'application/xml');
      invoice.authorize(
        {
          number: authorized.number,
          authorizedAt: authorizationVoucher.authorizationDate ?? new Date(authorized.date),
          xmlKey,
        },
        authorizationVoucher.messages,
      );
      // With its delivery (RIDE and email to the buyer), in the same transaction
      await this.invoiceRepository.saveAuthorized(
        invoice,
        InvoiceDelivery.forAuthorization(invoice, this.now(), this.traceContext()),
      );
    } else {
      invoice.reject(authorizationVoucher.messages);
      await this.invoiceRepository.updateInvoice(invoice);
    }
    logger.info(
      { invoiceId: invoice.id, status: invoice.status },
      'Invoice authorization completed',
    );
  }
}
