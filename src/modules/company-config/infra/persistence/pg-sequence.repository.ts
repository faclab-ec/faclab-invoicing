import { Pool, PoolClient } from 'pg';

import { SequenceRepository } from '../../domain/repository';
import { Sequence, SequenceKey } from '../../domain/sequence';

interface SequenceRow {
  tenant_id: string;
  establishment: string;
  emission_point: string;
  doc_type: string;
  // bigint: pg returns it as a string
  last_value: string;
}

function fromSequenceRow(row: SequenceRow): Sequence {
  return {
    tenantId: row.tenant_id,
    establishment: row.establishment,
    emissionPoint: row.emission_point,
    docType: row.doc_type,
    lastValue: Number(row.last_value),
  };
}

const keyParams = (key: SequenceKey) => [
  key.tenantId,
  key.establishment,
  key.emissionPoint,
  key.docType,
];

/**
 * Takes the next number of the key: 1 the first time. The row stays locked until `client`'s
 * transaction ends, so concurrent callers get consecutive numbers and none twice; a rollback gives
 * the number back.
 */
export async function takeNextSequence(client: PoolClient, key: SequenceKey): Promise<number> {
  const result = await client.query<{ last_value: string }>(
    `INSERT INTO sequences (tenant_id, establishment, emission_point, doc_type, last_value)
     VALUES ($1, $2, $3, $4, 1)
     ON CONFLICT (tenant_id, establishment, emission_point, doc_type)
       DO UPDATE SET last_value = sequences.last_value + 1
     RETURNING last_value`,
    keyParams(key),
  );
  return Number(result.rows[0].last_value);
}

export class PgSequenceRepository implements SequenceRepository {
  constructor(private readonly pool: Pool) {}

  async findAll(tenantId: string): Promise<Sequence[]> {
    const result = await this.pool.query<SequenceRow>(
      `SELECT * FROM sequences WHERE tenant_id = $1
       ORDER BY establishment, emission_point, doc_type`,
      [tenantId],
    );
    return result.rows.map(fromSequenceRow);
  }

  async find(key: SequenceKey): Promise<Sequence | null> {
    const result = await this.pool.query<SequenceRow>(
      `SELECT * FROM sequences
       WHERE tenant_id = $1 AND establishment = $2 AND emission_point = $3 AND doc_type = $4`,
      keyParams(key),
    );
    return result.rows[0] ? fromSequenceRow(result.rows[0]) : null;
  }

  async setNext(key: SequenceKey, next: number): Promise<Sequence | null> {
    // The WHERE skips the update (and returns nothing) when it would go back
    const result = await this.pool.query<SequenceRow>(
      `INSERT INTO sequences (tenant_id, establishment, emission_point, doc_type, last_value)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, establishment, emission_point, doc_type)
         DO UPDATE SET last_value = EXCLUDED.last_value
         WHERE sequences.last_value <= EXCLUDED.last_value
       RETURNING *`,
      [...keyParams(key), next - 1],
    );
    return result.rows[0] ? fromSequenceRow(result.rows[0]) : null;
  }
}
