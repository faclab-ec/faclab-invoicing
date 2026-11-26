import { Pool, PoolClient } from 'pg';

import { withTransaction } from '#/shared/infra/database';

/** Where the company is in its termination (S8.7); null before it starts */
export interface OffboardingState {
  tenantId: string;
  startedAt: Date;
  graceEndsAt: Date;
  retentionEndsAt: Date;
  anonymizedAt: Date | null;
  purgedAt: Date | null;
}

export interface CountsByTable {
  [table: string]: number;
}

export interface OffboardingPlan {
  /** Rows (and objects) that are deleted when anonymizing */
  purge: CountsByTable;
  /** Rows whose personal data is cleared when anonymizing */
  anonymize: CountsByTable;
  /** The accounting that stays until the retention ends */
  retain: CountsByTable;
  /** Documents still in the queue: anonymizing waits for them */
  inFlight: number;
}

export const ANONYMOUS_ACTOR = 'Usuario anonimizado';

type Row = Record<string, unknown>;

/** What faclab-invoicing keeps per company, read and changed as a whole (S8.7) */
export class PgTenantDataRepository {
  constructor(private readonly pool: Pool) {}

  /** The company with this RUC (its issuer profile); null if there is none */
  async findTenantByRuc(ruc: string): Promise<string | null> {
    const result = await this.pool.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM issuers WHERE tax_id = $1',
      [ruc],
    );
    return result.rows[0]?.tenant_id ?? null;
  }

  async rucOf(tenantId: string): Promise<string | null> {
    const result = await this.pool.query<{ tax_id: string }>(
      'SELECT tax_id FROM issuers WHERE tenant_id = $1',
      [tenantId],
    );
    return result.rows[0]?.tax_id ?? null;
  }

  // Reads for the export

  async issuer(tenantId: string): Promise<Row | null> {
    const result = await this.pool.query(
      `SELECT tenant_id, tax_id, name, trade_name, main_address, special_taxpayer_resolution,
              withholding_agent_resolution, rimpe_regime, accounting_required, environment,
              emission_type, email, logo_key, logo_content_type, updated_at
       FROM issuers WHERE tenant_id = $1`,
      [tenantId],
    );
    return result.rows[0] ?? null;
  }

  /** Metadata only: neither the .p12 nor its password leave the service */
  async certificates(tenantId: string): Promise<Row[]> {
    const result = await this.pool.query(
      `SELECT id, serial_number, subject, issuer, tax_ids, valid_from, valid_to, file_name,
              uploaded_at
       FROM certificates WHERE tenant_id = $1 ORDER BY uploaded_at, id`,
      [tenantId],
    );
    return result.rows;
  }

  async sequences(tenantId: string): Promise<Row[]> {
    const result = await this.pool.query(
      `SELECT establishment, emission_point, doc_type, last_value FROM sequences
       WHERE tenant_id = $1 ORDER BY establishment, emission_point, doc_type`,
      [tenantId],
    );
    return result.rows;
  }

  async audit(tenantId: string): Promise<Row[]> {
    const result = await this.pool.query(
      `SELECT id, action, actor_id, actor_name, detail, occurred_at FROM issuer_audit
       WHERE tenant_id = $1 ORDER BY id`,
      [tenantId],
    );
    return result.rows;
  }

  /**
   * Every document of the company in pages, oldest first (keyset): the buyer comes out of the
   * sale (invoices) or the invoice it modifies (credit notes)
   */
  async *invoices(tenantId: string, pageSize = 500): AsyncGenerator<Row[]> {
    let after: { createdAt: Date; id: string } | null = null;
    for (;;) {
      const result: { rows: Row[] } = await this.pool.query(
        `SELECT i.id, i.doc_type, i.sale_id, i.request_id, i.source_invoice_id, i.status,
                i.establishment, i.emission_point, i.sequence, i.access_code,
                i.authorization_number, i.authorized_at, i.authorized_xml_key, i.issue_code,
                i.issue_message, i.requested_at, i.created_at, i.updated_at,
                b.buyer->>'name' AS buyer_name, b.buyer->>'tax_id' AS buyer_tax_id,
                b.buyer->>'tax_type' AS buyer_tax_type, b.buyer->>'email' AS buyer_email,
                b.buyer->>'phone' AS buyer_phone, b.buyer->>'address' AS buyer_address
         FROM invoices i
         CROSS JOIN LATERAL (
           SELECT COALESCE(i.sale->'customer', i.credit_note->'modified'->'customer') AS buyer
         ) b
         WHERE i.tenant_id = $1 AND ($2::timestamptz IS NULL OR (i.created_at, i.id) > ($2::timestamptz, $3::uuid))
         ORDER BY i.created_at, i.id LIMIT $4`,
        [tenantId, after?.createdAt ?? null, after?.id ?? null, pageSize],
      );
      if (result.rows.length === 0) return;
      yield result.rows;
      const last = result.rows[result.rows.length - 1];
      after = { createdAt: last.created_at as Date, id: last.id as string };
    }
  }

  async *deliveries(tenantId: string, pageSize = 500): AsyncGenerator<Row[]> {
    let after: { createdAt: Date; id: string } | null = null;
    for (;;) {
      const result: { rows: Row[] } = await this.pool.query(
        `SELECT id, invoice_id, kind, recipient, requested_by, status, attempts, last_error,
                smtp_response, message_id, sent_at, created_at
         FROM invoice_deliveries
         WHERE tenant_id = $1 AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::uuid))
         ORDER BY created_at, id LIMIT $4`,
        [tenantId, after?.createdAt ?? null, after?.id ?? null, pageSize],
      );
      if (result.rows.length === 0) return;
      yield result.rows;
      const last = result.rows[result.rows.length - 1];
      after = { createdAt: last.created_at as Date, id: last.id as string };
    }
  }

  /** The authorized documents, to copy their XML and RIDE */
  async authorizedIds(tenantId: string): Promise<{ id: string; accessCode: string }[]> {
    const result = await this.pool.query<{ id: string; access_code: string }>(
      `SELECT id, access_code FROM invoices
       WHERE tenant_id = $1 AND status = 'authorized' AND access_code IS NOT NULL
       ORDER BY created_at, id`,
      [tenantId],
    );
    return result.rows.map((row) => ({ id: row.id, accessCode: row.access_code }));
  }

  // The offboarding

  async offboarding(tenantId: string): Promise<OffboardingState | null> {
    const result = await this.pool.query('SELECT * FROM tenant_offboarding WHERE tenant_id = $1', [
      tenantId,
    ]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      tenantId: row.tenant_id,
      startedAt: row.started_at,
      graceEndsAt: row.grace_ends_at,
      retentionEndsAt: row.retention_ends_at,
      anonymizedAt: row.anonymized_at,
      purgedAt: row.purged_at,
    };
  }

  async lastDocumentAt(tenantId: string): Promise<Date | null> {
    const result = await this.pool.query<{ last: Date | null }>(
      'SELECT max(created_at) AS last FROM invoices WHERE tenant_id = $1',
      [tenantId],
    );
    return result.rows[0]?.last ?? null;
  }

  /** False when the company's offboarding had already started */
  async start(
    tenantId: string,
    by: string,
    graceEndsAt: Date,
    retentionEndsAt: Date,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO tenant_offboarding
         (tenant_id, started_at, started_by, grace_ends_at, retention_ends_at)
       VALUES ($1, now(), $2, $3, $4) ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId, by, graceEndsAt, retentionEndsAt],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** The way back, while nothing was anonymized */
  async cancel(tenantId: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM tenant_offboarding WHERE tenant_id = $1 AND anonymized_at IS NULL',
      [tenantId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Documents of the company that haven't reached their final state, and deliveries to make */
  async inFlight(tenantId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT (SELECT count(*) FROM invoices
                WHERE tenant_id = $1 AND status NOT IN ('authorized', 'rejected'))
            + (SELECT count(*) FROM invoice_deliveries
                WHERE tenant_id = $1 AND status = 'pending') AS count`,
      [tenantId],
    );
    return Number(result.rows[0].count);
  }

  async plan(tenantId: string): Promise<OffboardingPlan> {
    const count = async (table: string, where = '') => {
      const result = await this.pool.query<{ count: string }>(
        `SELECT count(*) FROM ${table} WHERE tenant_id = $1 ${where}`,
        [tenantId],
      );
      return Number(result.rows[0].count);
    };
    const withBuyerData = await count(
      'invoices',
      `AND (sale->'customer' ?| ARRAY['email', 'phone']
            OR credit_note->'modified'->'customer' ?| ARRAY['email', 'phone']
            OR issue_message IS NOT NULL)`,
    );
    return {
      purge: {
        certificates: await count('certificates'),
        dead_letters: await count('dead_letters'),
      },
      anonymize: {
        invoices: withBuyerData,
        invoice_deliveries: await count('invoice_deliveries'),
        issuer_audit: await count('issuer_audit'),
        issuers: await count('issuers', 'AND (email IS NOT NULL OR logo_key IS NOT NULL)'),
      },
      retain: {
        invoices: await count('invoices'),
        sequences: await count('sequences'),
        issuers: await count('issuers'),
      },
      inFlight: await this.inFlight(tenantId),
    };
  }

  /**
   * Clears what tax law doesn't need, in one transaction: the buyers' email and phone outside the
   * signed documents (the XML and the RIDE are the legal record and stay as they were signed), the
   * deliveries' addresses and server answers, the SRI's free text, the dead letters, the
   * certificates with their keys, the issuer's email and logo, and the names in the audit log.
   * Returns what it did and the logo to delete from the storage.
   */
  async anonymize(
    tenantId: string,
    by: string,
  ): Promise<{ counts: CountsByTable; logoKey: string | null }> {
    return withTransaction(this.pool, async (client) => {
      await offboardingMode(client);
      const counts: CountsByTable = {};
      const run = async (name: string, sql: string, values: unknown[] = [tenantId]) => {
        counts[name] = (await client.query(sql, values)).rowCount ?? 0;
      };
      await run(
        'invoice_deliveries',
        `UPDATE invoice_deliveries
         SET recipient = NULL, requested_by = NULL, last_error = NULL, smtp_response = NULL,
             message_id = NULL
         WHERE tenant_id = $1`,
      );
      await run(
        'invoices',
        `UPDATE invoices SET
           issue_message = NULL,
           sale = CASE WHEN jsonb_typeof(sale->'customer') = 'object'
             THEN jsonb_set(sale, '{customer}', (sale->'customer') - 'email' - 'phone')
             ELSE sale END,
           credit_note = CASE WHEN jsonb_typeof(credit_note->'modified'->'customer') = 'object'
             THEN jsonb_set(credit_note, '{modified,customer}',
                            (credit_note->'modified'->'customer') - 'email' - 'phone')
             ELSE credit_note END
         WHERE tenant_id = $1`,
      );
      await run('dead_letters', 'DELETE FROM dead_letters WHERE tenant_id = $1');
      const issuer = await client.query<{ logo_key: string | null }>(
        'SELECT logo_key FROM issuers WHERE tenant_id = $1 FOR UPDATE',
        [tenantId],
      );
      await run(
        'issuers',
        `UPDATE issuers SET signing_cert_id = NULL, email = NULL, logo_key = NULL,
                            logo_content_type = NULL, updated_at = now()
         WHERE tenant_id = $1`,
      );
      await run('certificates', 'DELETE FROM certificates WHERE tenant_id = $1');
      await run(
        'issuer_audit',
        `UPDATE issuer_audit SET actor_name = '${ANONYMOUS_ACTOR}' WHERE tenant_id = $1`,
      );
      await run('api_rate_limits', `DELETE FROM api_rate_limits WHERE key LIKE '%' || $1 || '%'`);
      await client.query(
        'UPDATE tenant_offboarding SET anonymized_at = now(), anonymized_by = $2 WHERE tenant_id = $1',
        [tenantId, by],
      );
      return { counts, logoKey: issuer.rows[0]?.logo_key ?? null };
    });
  }

  /** Every row of the company, children first. Its offboarding row stays: the proof of erasure */
  async purge(tenantId: string, by: string): Promise<CountsByTable> {
    return withTransaction(this.pool, async (client) => {
      await offboardingMode(client);
      const counts: CountsByTable = {};
      const run = async (name: string, sql: string) => {
        counts[name] = (await client.query(sql, [tenantId])).rowCount ?? 0;
      };
      await run('invoice_deliveries', 'DELETE FROM invoice_deliveries WHERE tenant_id = $1');
      // A credit note points at the invoice it modifies: they go first
      await run('credit_notes', `DELETE FROM invoices WHERE tenant_id = $1 AND doc_type = '04'`);
      await run('invoices', 'DELETE FROM invoices WHERE tenant_id = $1');
      await run(
        'issuers',
        'UPDATE issuers SET signing_cert_id = NULL WHERE tenant_id = $1 AND signing_cert_id IS NOT NULL',
      );
      await run('issuers_deleted', 'DELETE FROM issuers WHERE tenant_id = $1');
      await run('certificates', 'DELETE FROM certificates WHERE tenant_id = $1');
      await run('sequences', 'DELETE FROM sequences WHERE tenant_id = $1');
      await run('issuer_audit', 'DELETE FROM issuer_audit WHERE tenant_id = $1');
      await run('dead_letters', 'DELETE FROM dead_letters WHERE tenant_id = $1');
      await client.query(
        'UPDATE tenant_offboarding SET purged_at = now(), purged_by = $2 WHERE tenant_id = $1',
        [tenantId, by],
      );
      return counts;
    });
  }
}

/** SET LOCAL: only this transaction may change issuer_audit (migration 1793800000000) */
async function offboardingMode(client: PoolClient): Promise<void> {
  await client.query(`SET LOCAL faclab.offboarding = 'on'`);
}
