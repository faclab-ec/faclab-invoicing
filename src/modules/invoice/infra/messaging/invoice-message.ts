import { InvoiceDomainEvent } from '../../domain/events';

// contracts/events/invoices/v<version>.schema.json, copied from faclab-core (contracts/README.md)
export const INVOICES_SCHEMA_VERSION = 1;

/**
 * The `invoices` message as its contract defines it: the domain event and its schema version. The
 * company goes in the `faclab-tenant-id` header (invoiceTenant), not in the closed v1 body.
 */
export function toInvoiceMessage(event: InvoiceDomainEvent) {
  const { tenantId: _tenantId, ...body } = event;
  return { schema_version: INVOICES_SCHEMA_VERSION, ...body };
}

export function invoiceTenant(event: InvoiceDomainEvent): string {
  return event.tenantId;
}
