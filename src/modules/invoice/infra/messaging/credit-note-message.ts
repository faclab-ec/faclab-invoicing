import { v5 as uuidv5 } from 'uuid';

import { CreditNoteResultEvent } from '../../domain/events';

// contracts/events/credit_notes.results/v<version>.schema.json, copied from faclab-core
export const CREDIT_NOTE_RESULTS_SCHEMA_VERSION = 1;

// Fixed namespace: a result published again carries the same event id
const RESULT_EVENT_NAMESPACE = '6e0f3a52-9d41-4c7b-8f2e-1b7a9c3d5e60';

/** The `credit_notes.results` message as its contract defines it */
export function toCreditNoteResultMessage(event: CreditNoteResultEvent) {
  return {
    event_id: uuidv5(`${event.documentId}:${event.type}`, RESULT_EVENT_NAMESPACE),
    event_type: event.type,
    schema_version: CREDIT_NOTE_RESULTS_SCHEMA_VERSION,
    tenant_id: event.tenantId,
    aggregate_id: event.creditNoteId,
    occurred_at: event.occurredAt.toISOString(),
    payload: {
      credit_note_id: event.creditNoteId,
      document_id: event.documentId,
      sale_id: Number(event.saleId),
      number: event.number,
      access_code: event.accessCode,
      authorized_at: event.authorizedAt?.toISOString() ?? null,
      reason: event.reason,
    },
  };
}

export function creditNoteTenant(event: CreditNoteResultEvent): string {
  return event.tenantId;
}
