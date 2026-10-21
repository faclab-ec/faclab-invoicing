import { Pool, PoolClient } from 'pg';

import { logger } from '#/shared/logger';

export function createPool(connectionString: string): Pool {
  const pool = new Pool({ connectionString });
  // An idle connection that breaks (database restart) is dropped from the pool; without a
  // listener the error would crash the process
  pool.on('error', (error) => logger.error({ err: error }, 'Idle database connection failed'));
  return pool;
}

/** Runs `work` in a transaction: commits what it did, or rolls it all back if it throws */
export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch((rollbackError: Error) => {
      broken = rollbackError;
    });
    throw error;
  } finally {
    // A connection that can't even roll back is discarded instead of going back to the pool
    client.release(broken);
  }
}
