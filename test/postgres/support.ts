import { randomBytes } from 'crypto';
import { runner } from 'node-pg-migrate';
import { resolve } from 'path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe } from 'vitest';

const DATABASE_URL = process.env.TEST_DATABASE_URL;

/** Tests against PostgreSQL: skipped without TEST_DATABASE_URL (a database named *_test) */
export const describePostgres = describe.skipIf(!DATABASE_URL);

/**
 * A schema of its own with the migrations applied, for the tests of one file: files run in
 * parallel without seeing each other's rows. Every test starts with empty tables (no sequences
 * either). Call it inside `describePostgres`.
 */
export function usePostgres(): () => Pool {
  const schema = `test_${randomBytes(6).toString('hex')}`;
  let pool: Pool | undefined;

  beforeAll(async () => {
    const url = DATABASE_URL!;
    const database = new URL(url).pathname.slice(1);
    // The tests empty the tables they use: never against a real database
    if (!database.endsWith('_test')) {
      throw new Error(`TEST_DATABASE_URL must name a *_test database, not ${database}`);
    }
    await runner({
      databaseUrl: url,
      dir: resolve('migrations'),
      direction: 'up',
      migrationsTable: 'pgmigrations',
      schema,
      createSchema: true,
      advisoryLockMode: 'wait',
      verbose: false,
      log: () => undefined,
    });
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
  });

  beforeEach(async () => {
    await pool!.query('TRUNCATE invoice_events, invoices, issuers, certificates, sequences');
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  });

  return () => pool!;
}

/** Another pool on the same schema, like a second process of the service; the caller ends it */
export function anotherPool(pool: Pool): Pool {
  return new Pool({ ...pool.options });
}
