import { NonRetryableError } from '#/shared/errors/non-retryable.error';

import { InvoiceDomainEvent } from '../../domain/events';
import { MessageProducer } from '../../domain/ports';
import { SaleConfirmedMessage } from '../../infra/messaging/schemas';
import { ReceivedSale, ReceiveSaleCommand } from '../commands/receive-sale';

// v1 doesn't say where the sale was made: the main establishment and its first emission point
const V1_ESTABLISHMENT = '001';
const V1_EMISSION_POINT = '001';

/**
 * The sale and who issues it, by message version. v2 names the company, its RUC and the sale's
 * establishment and emission point. v1 names none of them: it is invoiced by `v1TenantId`, the
 * default issuer of a development setup (SALES_V1_TENANT_ID); without one it can't be invoiced.
 */
export function toReceivedSale(
  message: SaleConfirmedMessage,
  v1TenantId: string | null,
): ReceivedSale {
  if (message.schema_version === 2) {
    const {
      sale_number: _number,
      issuer_ruc,
      establishment_code,
      establishment_address,
      emission_point_code,
      ...sale
    } = message.payload;
    return {
      eventId: message.event_id,
      point: {
        tenantId: message.tenant_id.toLowerCase(),
        issuerRuc: issuer_ruc,
        establishment: establishment_code,
        emissionPoint: emission_point_code,
        establishmentAddress: establishment_address,
      },
      sale,
    };
  }
  if (!v1TenantId) {
    throw new NonRetryableError(
      `sales.confirmed v1 (event ${message.event_id}) names no company: only a development setup with SALES_V1_TENANT_ID invoices it`,
    );
  }
  return {
    eventId: message.event_id,
    point: {
      tenantId: v1TenantId,
      issuerRuc: null,
      establishment: V1_ESTABLISHMENT,
      emissionPoint: V1_EMISSION_POINT,
      establishmentAddress: null,
    },
    sale: message.payload,
  };
}

export class SaleConfirmedHandler {
  constructor(
    private receiveSaleCommand: ReceiveSaleCommand,
    private messageProducer: MessageProducer<InvoiceDomainEvent>,
    // The default issuer of v1 messages (development only)
    private v1TenantId: string | null = null,
  ) {}

  async handle(message: SaleConfirmedMessage): Promise<void> {
    const invoice = await this.receiveSaleCommand.execute(toReceivedSale(message, this.v1TenantId));
    if (!invoice) return;
    // InvoiceReceived starts the flow; if it's lost, the recovery job picks it up
    for (const event of invoice.pullEvents()) {
      await this.messageProducer.sendMessage(event);
    }
  }
}
