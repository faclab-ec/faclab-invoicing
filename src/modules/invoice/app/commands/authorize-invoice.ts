import { logger } from '#/shared/logger';

import { Invoice } from '../../domain/invoice';
import { InvoiceIssueError } from '../../domain/issue';
import { SriAuthorizationPort } from '../../domain/ports';
import { InvoiceRepository } from '../../domain/repository';
import { AuthorizationVoucherStatus } from '../../domain/voucher';
import { InvoiceCommand } from './command';

export class AuthorizeInvoiceCommand implements InvoiceCommand {
  constructor(
    private sriAuthorizationPort: SriAuthorizationPort,
    private invoiceRepository: InvoiceRepository,
  ) {}

  async execute(invoice: Invoice): Promise<void> {
    const accessCode = invoice.requireAccessCode().value;
    logger.info({ invoiceId: invoice.id, accessCode }, 'Authorizing invoice');
    const authorizationVoucher = await this.sriAuthorizationPort.authorizeXml(accessCode);
    if (authorizationVoucher.status === AuthorizationVoucherStatus.PROCESSING) {
      // Not an answer yet: stays `sent` and is asked again later
      throw new InvoiceIssueError(
        'SRI_PROCESSING',
        'The SRI has not finished processing the invoice',
      );
    }
    if (authorizationVoucher.status === AuthorizationVoucherStatus.AUTHORIZED) {
      invoice.authorize(authorizationVoucher.messages);
    } else {
      invoice.reject(authorizationVoucher.messages);
    }
    await this.invoiceRepository.updateInvoice(invoice);
    logger.info(
      { invoiceId: invoice.id, status: invoice.status },
      'Invoice authorization completed',
    );
  }
}
