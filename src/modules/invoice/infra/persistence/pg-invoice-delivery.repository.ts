import { Pool, PoolClient } from 'pg';
import { validate as isUuid } from 'uuid';

import { DeliveryKind, DeliveryStatus, InvoiceDelivery } from '../../domain/delivery';
import { TraceContext } from '../../domain/invoice';
import { ClaimedDelivery, DeliveryQueue } from '../../domain/queue';
import { InvoiceDeliveryRepository } from '../../domain/repository';

/** A row of `invoice_deliveries` */
interface DeliveryRow {
  id: string;
  tenant_id: string;
  invoice_id: string;
  kind: DeliveryKind;
  recipient: string | null;
  requested_by: string | null;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: Date | null;
  last_error: string | null;
  smtp_response: string | null;
  message_id: string | null;
  sent_at: Date | null;
  trace_context: TraceContext | null;
  created_at: Date;
  updated_at: Date;
}

function fromRow(row: DeliveryRow): InvoiceDelivery {
  return new InvoiceDelivery({
    id: row.id,
    tenantId: row.tenant_id,
    invoiceId: row.invoice_id,
    kind: row.kind,
    recipient: row.recipient,
    requestedBy: row.requested_by,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    smtpResponse: row.smtp_response,
    messageId: row.message_id,
    sentAt: row.sent_at,
    traceContext: row.trace_context,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/**
 * Inserts the delivery unless the invoice already has its authorization delivery or a pending one
 * (both unique indexes): false then. In the caller's transaction.
 */
export async function insertDelivery(
  client: Pool | PoolClient,
  delivery: InvoiceDelivery,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO invoice_deliveries (
       id, tenant_id, invoice_id, kind, recipient, requested_by, status, attempts,
       next_attempt_at, last_error, smtp_response, message_id, sent_at, trace_context,
       created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT DO NOTHING`,
    [
      delivery.id,
      delivery.tenantId,
      delivery.invoiceId,
      delivery.kind,
      delivery.recipient,
      delivery.requestedBy,
      delivery.status,
      delivery.attempts,
      delivery.nextAttemptAt,
      delivery.lastError,
      delivery.smtpResponse,
      delivery.messageId,
      delivery.sentAt,
      delivery.traceContext,
      delivery.createdAt,
      delivery.updatedAt,
    ],
  );
  return result.rowCount === 1;
}

/**
 * The deliveries and, over the same table, their queue: the pending ones are due at
 * `next_attempt_at`, and `locked_until` / `locked_by` say who holds one, like `invoices`.
 */
export class PgInvoiceDeliveryRepository implements InvoiceDeliveryRepository, DeliveryQueue {
  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getById(id: string): Promise<InvoiceDelivery | null> {
    if (!isUuid(id)) return null;
    const result = await this.pool.query<DeliveryRow>(
      'SELECT * FROM invoice_deliveries WHERE id = $1',
      [id],
    );
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  // The lease is the queue's: saving the result doesn't touch it
  async update(delivery: InvoiceDelivery): Promise<void> {
    await this.pool.query(
      `UPDATE invoice_deliveries SET
         status = $2, attempts = $3, next_attempt_at = $4, last_error = $5, smtp_response = $6,
         message_id = $7, sent_at = $8, updated_at = $9
       WHERE id = $1`,
      [
        delivery.id,
        delivery.status,
        delivery.attempts,
        delivery.nextAttemptAt,
        delivery.lastError,
        delivery.smtpResponse,
        delivery.messageId,
        delivery.sentAt,
        delivery.updatedAt,
      ],
    );
  }

  async createResend(delivery: InvoiceDelivery): Promise<InvoiceDelivery> {
    // Twice at most: the pending one it collided with may finish before it is read
    for (let attempt = 0; attempt < 2; attempt++) {
      if (await insertDelivery(this.pool, delivery)) return delivery;
      const pending = await this.pool.query<DeliveryRow>(
        `SELECT * FROM invoice_deliveries
         WHERE tenant_id = $1 AND invoice_id = $2 AND status = 'pending'`,
        [delivery.tenantId, delivery.invoiceId],
      );
      if (pending.rows[0]) return fromRow(pending.rows[0]);
    }
    throw new Error(`The delivery of invoice ${delivery.invoiceId} could not be created`);
  }

  async findByInvoice(tenantId: string, invoiceId: string): Promise<InvoiceDelivery[]> {
    if (!isUuid(invoiceId)) return [];
    const result = await this.pool.query<DeliveryRow>(
      `SELECT * FROM invoice_deliveries
       WHERE tenant_id = $1 AND invoice_id = $2
       ORDER BY created_at DESC, id`,
      [tenantId, invoiceId],
    );
    return result.rows.map(fromRow);
  }

  async claimDue(holder: string, leaseMs: number, limit: number): Promise<ClaimedDelivery[]> {
    const now = this.now();
    const result = await this.pool.query<{
      id: string;
      invoice_id: string;
      trace_context: TraceContext | null;
    }>(
      `UPDATE invoice_deliveries d SET locked_until = $2, locked_by = $3
       FROM (
         SELECT id FROM invoice_deliveries
         WHERE status = 'pending' AND next_attempt_at <= $1
           AND (locked_until IS NULL OR locked_until < $1)
         ORDER BY next_attempt_at, id
         LIMIT $4
         FOR UPDATE SKIP LOCKED
       ) due
       WHERE d.id = due.id
       RETURNING d.id, d.invoice_id, d.trace_context`,
      [now, new Date(now.getTime() + leaseMs), holder, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      invoiceId: row.invoice_id,
      traceContext: row.trace_context,
    }));
  }

  async release(id: string, holder: string): Promise<void> {
    await this.pool.query(
      `UPDATE invoice_deliveries SET locked_until = NULL, locked_by = NULL
       WHERE id = $1 AND locked_by = $2`,
      [id, holder],
    );
  }

  async postpone(id: string, at: Date): Promise<void> {
    await this.pool.query(
      `UPDATE invoice_deliveries SET next_attempt_at = $2 WHERE id = $1 AND status = 'pending'`,
      [id, at],
    );
  }
}
