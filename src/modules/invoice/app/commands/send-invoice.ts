import { logger } from '#/shared/logger';

import { Invoice } from '../../domain/invoice';
import { SriValidationPort } from '../../domain/ports';
import { InvoiceRepository } from '../../domain/repository';
import { ValidationVoucherStatus } from '../../domain/voucher';
import { InvoiceCommand } from './command';

export class SendInvoiceCommand implements InvoiceCommand {
  constructor(
    private sriValidationPort: SriValidationPort,
    private invoiceRepository: InvoiceRepository,
  ) {}

  async execute(invoice: Invoice): Promise<void> {
    logger.info({ invoiceId: invoice.id }, 'Sending invoice to SRI');
    // To the environment its access code was issued for
    const validationVoucher = await this.sriValidationPort.validateXml(
      invoice.requireXml(),
      invoice.requireAccessCode().environment,
    );
    // A retry after a timeout may find the SRI already has it: go on to authorization
    if (
      validationVoucher.status === ValidationVoucherStatus.ACCEPTED ||
      validationVoucher.alreadyReceived
    ) {
      invoice.markAsSent(validationVoucher.messages);
    } else {
      invoice.reject(validationVoucher.messages);
    }
    await this.invoiceRepository.updateInvoice(invoice);
    logger.info({ invoiceId: invoice.id, status: invoice.status }, 'Invoice sent to SRI');
  }
}
