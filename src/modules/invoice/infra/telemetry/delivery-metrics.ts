import { invoiceDeliveries } from '#/shared/telemetry/metrics';

import { DeliveryStatus } from '../../domain/delivery';

/**
 * Counts how a delivery attempt ended: still pending means it failed and waits for the next one
 * (`retry`). Null: there was nothing to deliver
 */
export function recordDelivery(status: DeliveryStatus | null): void {
  if (status === null) return;
  invoiceDeliveries.add(1, { result: status === 'pending' ? 'retry' : status });
}
