import { Pool } from 'pg';
import { validate as isUuid } from 'uuid';

import { TraceContext } from '../../domain/invoice';
import { InvoiceIssueCode } from '../../domain/issue';
import { ClaimedInvoice, InvoiceQueue, WaitingInvoice } from '../../domain/queue';
import { IN_FLIGHT_STATUSES } from './pg-invoice.repository';

/**
 * The queue over `invoices`: `next_attempt_at` says when an invoice is due and `locked_until` /
 * `locked_by` who holds it. Times come from the service's clock, the same one that sets
 * `next_attempt_at`. None of these statements changes `version`.
 */
export class PgInvoiceQueue implements InvoiceQueue {
  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async claimDue(holder: string, leaseMs: number, limit: number): Promise<ClaimedInvoice[]> {
    const now = this.now();
    // Locks the due rows it picks and skips those another worker is picking at the same time
    const result = await this.pool.query<{ id: string; trace_context: TraceContext | null }>(
      `UPDATE invoices i SET locked_until = $2, locked_by = $3
       FROM (
         SELECT id FROM invoices
         WHERE next_attempt_at <= $1 AND (locked_until IS NULL OR locked_until < $1)
         ORDER BY next_attempt_at, id
         LIMIT $4
         FOR UPDATE SKIP LOCKED
       ) due
       WHERE i.id = due.id
       RETURNING i.id, i.trace_context`,
      [now, leaseUntil(now, leaseMs), holder, limit],
    );
    return result.rows.map((row) => ({ id: row.id, traceContext: row.trace_context }));
  }

  async claim(id: string, holder: string, leaseMs: number): Promise<boolean> {
    if (!isUuid(id)) return false;
    const now = this.now();
    // Waits for a worker picking it right now, then sees its lease
    const result = await this.pool.query(
      `UPDATE invoices SET locked_until = $2, locked_by = $3
       WHERE id = $1 AND (locked_until IS NULL OR locked_until < $4)`,
      [id, leaseUntil(now, leaseMs), holder, now],
    );
    return result.rowCount === 1;
  }

  async renew(id: string, holder: string, leaseMs: number): Promise<boolean> {
    const result = await this.pool.query(
      'UPDATE invoices SET locked_until = $3 WHERE id = $1 AND locked_by = $2',
      [id, holder, leaseUntil(this.now(), leaseMs)],
    );
    return result.rowCount === 1;
  }

  async release(id: string, holder: string): Promise<void> {
    await this.pool.query(
      'UPDATE invoices SET locked_until = NULL, locked_by = NULL WHERE id = $1 AND locked_by = $2',
      [id, holder],
    );
  }

  async postpone(id: string, at: Date): Promise<void> {
    await this.pool.query('UPDATE invoices SET next_attempt_at = $2 WHERE id = $1', [id, at]);
  }

  async findWaiting(tenantId?: string): Promise<WaitingInvoice[]> {
    const params: unknown[] = [IN_FLIGHT_STATUSES, this.now()];
    if (tenantId !== undefined) params.push(tenantId);
    const result = await this.pool.query<{
      id: string;
      tenant_id: string;
      issuer_ruc: string | null;
      issue_code: string | null;
      next_attempt_at: Date | null;
    }>(
      `SELECT id, tenant_id, issuer_ruc, issue_code, next_attempt_at FROM invoices
       WHERE status = ANY($1) AND (next_attempt_at IS NULL OR next_attempt_at > $2)
         ${tenantId !== undefined ? 'AND tenant_id = $3' : ''}
       ORDER BY created_at, id`,
      params,
    );
    return result.rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      issuerRuc: row.issuer_ruc,
      issueCode: row.issue_code as InvoiceIssueCode | null,
      nextAttemptAt: row.next_attempt_at,
    }));
  }

  async requeue(ids: string[], at: Date): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.pool.query(
      `UPDATE invoices SET next_attempt_at = $2
       WHERE id = ANY($1::uuid[]) AND status = ANY($3)
         AND (next_attempt_at IS NULL OR next_attempt_at > $2)`,
      [ids, at, IN_FLIGHT_STATUSES],
    );
    return result.rowCount ?? 0;
  }
}

const leaseUntil = (now: Date, leaseMs: number) => new Date(now.getTime() + leaseMs);
