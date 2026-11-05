import {
  CreditNoteResultEvent,
  InvoiceResultEvent,
  isCreditNoteResult,
  VoucherResultEvent,
} from '../../domain/events';
import { MessageProducer } from '../../domain/ports';

/**
 * Each document's result on its topic: in `invoices`, a credit note would mark the sale as invoiced
 */
export class VoucherResultProducer implements MessageProducer<VoucherResultEvent> {
  constructor(
    private readonly invoices: MessageProducer<InvoiceResultEvent>,
    private readonly creditNotes: MessageProducer<CreditNoteResultEvent>,
  ) {}

  async sendMessage(event: VoucherResultEvent): Promise<void> {
    if (isCreditNoteResult(event)) await this.creditNotes.sendMessage(event);
    else await this.invoices.sendMessage(event);
  }
}
