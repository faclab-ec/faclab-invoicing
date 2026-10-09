import { InvoiceDomainEvent } from '../../domain/events';
import { MessageProducer } from '../../domain/ports';
import { SaleConfirmedMessage } from '../../infra/messaging/schemas';
import { ReceiveSaleCommand } from '../commands/receive-sale';

export class SaleConfirmedHandler {
  constructor(
    private receiveSaleCommand: ReceiveSaleCommand,
    private messageProducer: MessageProducer<InvoiceDomainEvent>,
  ) {}

  async handle(message: SaleConfirmedMessage): Promise<void> {
    const invoice = await this.receiveSaleCommand.execute(message);
    if (!invoice) return;
    // InvoiceReceived starts the flow; if it's lost, the recovery job picks it up
    for (const event of invoice.pullEvents()) {
      await this.messageProducer.sendMessage(event);
    }
  }
}
