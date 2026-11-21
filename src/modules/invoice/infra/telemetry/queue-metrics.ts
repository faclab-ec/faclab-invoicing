import { Attributes } from '@opentelemetry/api';

import { VoucherType } from '#/modules/company-config/domain/sequence';
import {
  invoicesDue,
  invoicesExpiredLeases,
  invoicesOldestAge,
  invoicesPending,
  invoicesPendingDeliveries,
  Point,
} from '#/shared/telemetry/metrics';

import { ISSUE_CODES } from '../../domain/issue';
import { DeliveryStats, InvoiceQueueStats } from '../../domain/queue';
import { IN_FLIGHT_STATUSES } from '../persistence/pg-invoice.repository';
import { documentTypeLabel } from './attributes';

const KNOWN_ISSUES = new Set<string>(ISSUE_CODES);

/** `faclab.issue.type`: the code of the issue that holds the documents, `none`, `other` if unknown */
export function issueTypeLabel(code: string | null): string {
  if (code === null) return 'none';
  return KNOWN_ISSUES.has(code) ? code : 'other';
}

/**
 * Samples the queue into its gauges: documents not yet final by status, issue and type, the age of
 * the oldest by status, the due ones and the expired leases. Every status of each type reports,
 * at 0 if empty, so its series drops instead of disappearing.
 */
export async function sampleInvoiceQueue(
  source: InvoiceQueueStats,
  now: Date,
  maxAgeMs: number,
): Promise<void> {
  const stats = await source.stats(now);

  const pending = new Map<string, { value: number; attributes: Attributes }>();
  const add = (status: string, docType: VoucherType, issue: string, count: number) => {
    const attributes = {
      status,
      'faclab.issue.type': issue,
      'faclab.document.type': documentTypeLabel(docType),
    };
    const key = JSON.stringify(attributes);
    const entry = pending.get(key) ?? { value: 0, attributes };
    entry.value += count;
    pending.set(key, entry);
  };
  for (const status of IN_FLIGHT_STATUSES) {
    for (const docType of Object.values(VoucherType)) add(status, docType, 'none', 0);
  }
  const oldest = new Map<string, Date>();
  for (const group of stats.inFlight) {
    add(group.status, group.docType, issueTypeLabel(group.issueCode), group.count);
    const current = oldest.get(group.status);
    if (!current || group.oldestCreatedAt < current) {
      oldest.set(group.status, group.oldestCreatedAt);
    }
  }

  invoicesPending.replace(
    [...pending.values()].map(({ value, attributes }): Point => [value, attributes]),
    maxAgeMs,
  );
  invoicesOldestAge.replace(
    IN_FLIGHT_STATUSES.map((status): Point => {
      const since = oldest.get(status);
      return [since ? Math.max(0, (now.getTime() - since.getTime()) / 1000) : 0, { status }];
    }),
    maxAgeMs,
  );
  invoicesDue.replace([[stats.due, {}]], maxAgeMs);
  invoicesExpiredLeases.replace([[stats.expiredLeases, {}]], maxAgeMs);
}

/** Samples the deliveries waiting to be sent */
export async function samplePendingDeliveries(
  source: DeliveryStats,
  maxAgeMs: number,
): Promise<void> {
  invoicesPendingDeliveries.replace([[await source.countPending(), {}]], maxAgeMs);
}
