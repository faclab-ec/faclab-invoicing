import { logger } from '#/shared/logger';

import { Invoice } from '../../domain/invoice';
import { InvoiceSignerPort } from '../../domain/ports';
import { InvoiceRepository } from '../../domain/repository';
import { InvoiceCommand } from './command';

export class SignInvoiceCommand implements InvoiceCommand {
  constructor(
    private invoiceSigner: InvoiceSignerPort,
    private invoiceRepository: InvoiceRepository,
  ) {}

  async execute(invoice: Invoice): Promise<void> {
    logger.info({ invoiceId: invoice.id }, 'Signing invoice');
    const signedXml = await this.invoiceSigner.signInvoice(invoice.requireXml());
    invoice.sign(signedXml);
    await this.invoiceRepository.updateInvoice(invoice);
    logger.info({ invoiceId: invoice.id }, 'Invoice signed');
  }
}
