import { Pool } from 'pg';
import { validate as isUuid } from 'uuid';

import { NotFoundError } from '../errors/app-error';
import { logger } from '../logger';
import { dlqMessageCount } from '../telemetry/metrics';

// Header with the company of a message, the same name faclab-core uses
const TENANT_HEADER = 'faclab-tenant-id';

export type DeadLetterErrorType = 'NON_RETRYABLE' | 'MAX_RETRIES_EXHAUSTED';
export type DeadLetterStatus = 'pending' | 'reprocessed';

/** A Kafka message as it arrived */
export interface FailedMessage {
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
  headers: Record<string, string>;
  value: string;
}

export interface DeadLetter extends FailedMessage {
  id: number;
  consumerGroup: string;
  tenantId: string | null;
  error: string;
  errorType: DeadLetterErrorType;
  attempts: number;
  status: DeadLetterStatus;
  createdAt: Date;
  reprocessedAt: Date | null;
  reprocessedBy: string | null;
  reprocessError: string | null;
}

/** Where the consumer keeps the messages it gave up on, until someone processes them again */
export interface DeadLetterStore {
  /**
   * Keeps the message once (a redelivery of the same offset adds nothing). If it throws, the
   * consumer must not commit the offset
   */
  keep(
    message: FailedMessage,
    error: Error,
    errorType: DeadLetterErrorType,
    attempts: number,
  ): Promise<void>;
  get(id: number): Promise<DeadLetter | null>;
  /** The pending ones, oldest first */
  pending(limit: number, afterId?: number): Promise<DeadLetter[]>;
  markReprocessed(id: number, by: string, at: Date): Promise<void>;
  recordReprocessFailure(id: number, error: string): Promise<void>;
}

interface DeadLetterRow {
  id: string;
  consumer_group: string;
  topic: string;
  kafka_partition: number;
  kafka_offset: string;
  key: string | null;
  tenant_id: string | null;
  headers: Record<string, string>;
  value: string;
  error: string;
  error_type: DeadLetterErrorType;
  attempts: number;
  status: DeadLetterStatus;
  created_at: Date;
  reprocessed_at: Date | null;
  reprocessed_by: string | null;
  reprocess_error: string | null;
}

const toDeadLetter = (row: DeadLetterRow): DeadLetter => ({
  id: Number(row.id),
  consumerGroup: row.consumer_group,
  topic: row.topic,
  partition: row.kafka_partition,
  offset: row.kafka_offset,
  key: row.key,
  tenantId: row.tenant_id,
  headers: row.headers,
  value: row.value,
  error: row.error,
  errorType: row.error_type,
  attempts: row.attempts,
  status: row.status,
  createdAt: row.created_at,
  reprocessedAt: row.reprocessed_at,
  reprocessedBy: row.reprocessed_by,
  reprocessError: row.reprocess_error,
});

/** `dead_letters` in PostgreSQL, shared by every company (a message may carry none) */
export class PgDeadLetterStore implements DeadLetterStore {
  constructor(
    private readonly pool: Pool,
    private readonly consumerGroup: string,
  ) {}

  async keep(
    message: FailedMessage,
    error: Error,
    errorType: DeadLetterErrorType,
    attempts: number,
  ): Promise<void> {
    const tenant = message.headers[TENANT_HEADER];
    const result = await this.pool.query(
      `INSERT INTO dead_letters (consumer_group, topic, kafka_partition, kafka_offset, key,
         tenant_id, headers, value, error, error_type, attempts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT ON CONSTRAINT uq_dead_letters_message DO NOTHING`,
      [
        this.consumerGroup,
        message.topic,
        message.partition,
        message.offset,
        message.key,
        // A header that isn't a company id can't go in the column: the message keeps it
        tenant && isUuid(tenant) ? tenant.toLowerCase() : null,
        message.headers,
        message.value,
        error.message,
        errorType,
        attempts,
      ],
    );
    if (result.rowCount === 0) return;

    dlqMessageCount.add(1, { original_topic: message.topic, error_type: errorType });
    logger.warn(
      {
        topic: message.topic,
        partition: message.partition,
        offset: message.offset,
        errorType,
        err: error,
      },
      'Message kept as a dead letter',
    );
  }

  async get(id: number): Promise<DeadLetter | null> {
    const result = await this.pool.query<DeadLetterRow>(
      'SELECT * FROM dead_letters WHERE id = $1',
      [id],
    );
    return result.rows[0] ? toDeadLetter(result.rows[0]) : null;
  }

  async pending(limit: number, afterId = 0): Promise<DeadLetter[]> {
    const result = await this.pool.query<DeadLetterRow>(
      `SELECT * FROM dead_letters WHERE status = 'pending' AND id > $1 ORDER BY id LIMIT $2`,
      [afterId, limit],
    );
    return result.rows.map(toDeadLetter);
  }

  async markReprocessed(id: number, by: string, at: Date): Promise<void> {
    await this.pool.query(
      `UPDATE dead_letters
       SET status = 'reprocessed', reprocessed_at = $3, reprocessed_by = $2, reprocess_error = NULL
       WHERE id = $1`,
      [id, by, at],
    );
  }

  async recordReprocessFailure(id: number, error: string): Promise<void> {
    await this.pool.query('UPDATE dead_letters SET reprocess_error = $2 WHERE id = $1', [
      id,
      error,
    ]);
  }
}

export interface ReprocessResult {
  id: number;
  reprocessed: boolean;
  error?: string;
}

/**
 * Processes dead letters again through the handler of their topic, the same one the consumer runs
 * (`dispatch`): for `sales.confirmed`, a `pending` invoice that the worker then invoices. Safe to
 * repeat: the same `event_id` always gives the same invoice. Records who did it, on the row and in
 * the log; a message that fails again stays pending with the error.
 */
export class DeadLetterReprocessor {
  constructor(
    private readonly store: DeadLetterStore,
    private readonly dispatch: (topic: string, value: string) => Promise<void>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reprocess(id: number, by: string): Promise<ReprocessResult> {
    const letter = await this.store.get(id);
    if (!letter) throw new NotFoundError(`Dead letter ${id} not found`);
    if (letter.status === 'reprocessed') {
      return { id, reprocessed: false, error: `already reprocessed by ${letter.reprocessedBy}` };
    }
    return this.run(letter, by);
  }

  /** Every pending one, oldest first, in batches */
  async reprocessAll(by: string, batchSize = 100): Promise<ReprocessResult[]> {
    const results: ReprocessResult[] = [];
    let afterId = 0;
    for (;;) {
      const batch = await this.store.pending(batchSize, afterId);
      for (const letter of batch) results.push(await this.run(letter, by));
      if (batch.length < batchSize) return results;
      afterId = batch[batch.length - 1].id;
    }
  }

  private async run(letter: DeadLetter, by: string): Promise<ReprocessResult> {
    const context = { deadLetterId: letter.id, topic: letter.topic, by };
    try {
      await this.dispatch(letter.topic, letter.value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.recordReprocessFailure(letter.id, message);
      logger.warn({ ...context, err: error }, 'Dead letter failed again');
      return { id: letter.id, reprocessed: false, error: message };
    }
    await this.store.markReprocessed(letter.id, by, this.now());
    logger.info(context, 'Dead letter reprocessed');
    return { id: letter.id, reprocessed: true };
  }
}
