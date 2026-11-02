import { CreditNoteRequestedMessage } from '../../infra/messaging/schemas';
import { ReceiveCreditNoteCommand, ReceivedCreditNote } from '../commands/receive-credit-note';

/** The credit note and who issues it, as the message says */
export function toReceivedCreditNote(message: CreditNoteRequestedMessage): ReceivedCreditNote {
  const {
    issuer_ruc,
    establishment_code,
    establishment_address,
    emission_point_code,
    ...creditNote
  } = message.payload;
  return {
    eventId: message.event_id,
    requestedAt: message.occurred_at,
    point: {
      tenantId: message.tenant_id.toLowerCase(),
      issuerRuc: issuer_ruc,
      establishment: establishment_code,
      emissionPoint: emission_point_code,
      establishmentAddress: establishment_address,
    },
    creditNote,
  };
}

/** Stores the credit note; the offset is committed once it is saved */
export class CreditNoteRequestedHandler {
  constructor(private receiveCreditNoteCommand: ReceiveCreditNoteCommand) {}

  async handle(message: CreditNoteRequestedMessage): Promise<void> {
    await this.receiveCreditNoteCommand.execute(toReceivedCreditNote(message));
  }
}
