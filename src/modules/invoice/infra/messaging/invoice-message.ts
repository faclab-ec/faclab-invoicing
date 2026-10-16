import { InvoiceDomainEvent } from '../../domain/events';

// contracts/events/invoices/v<version>.schema.json, copied from faclab-core (contracts/README.md)
export const INVOICES_SCHEMA_VERSION = 1;

/** The `invoices` message as its contract defines it: the domain event and its schema version */
export function toInvoiceMessage(event: InvoiceDomainEvent) {
  return { schema_version: INVOICES_SCHEMA_VERSION, ...event };
}
