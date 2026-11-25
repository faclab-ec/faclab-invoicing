import { Pool } from 'pg';

import { ONBOARDING_SALE_SOURCE } from '#/modules/invoice/domain/sale';
import { withTransaction } from '#/shared/infra/database';

import { Environment } from '../../domain/company-config';
import {
  IssuerProductionRepository,
  ProductionActor,
  ProductionResult,
} from '../../domain/production';
import { VoucherType } from '../../domain/sequence';

export class PgIssuerProductionRepository implements IssuerProductionRepository {
  constructor(private readonly pool: Pool) {}

  async enterProduction(
    tenantId: string,
    actor: ProductionActor,
  ): Promise<ProductionResult | null> {
    return withTransaction(this.pool, async (client) => {
      const issuer = await client.query<{ environment: number }>(
        'SELECT environment FROM issuers WHERE tenant_id = $1 FOR UPDATE',
        [tenantId],
      );
      if (issuer.rows[0]?.environment !== Environment.TESTING) return null;

      // The numbers the test invoices took go back, but only when they are the last ones: a
      // counter that moved on keeps its value, so no number is ever issued twice
      const restored = await client.query(
        `UPDATE sequences s SET last_value = t.first_number - 1
         FROM (
           SELECT establishment, emission_point,
                  min(sequence::bigint) AS first_number, max(sequence::bigint) AS last_number
           FROM invoices
           WHERE tenant_id = $1 AND doc_type = $2 AND sale->>'source' = $3 AND sequence IS NOT NULL
           GROUP BY establishment, emission_point
         ) t
         WHERE s.tenant_id = $1 AND s.doc_type = $2
           AND s.establishment = t.establishment AND s.emission_point = t.emission_point
           AND s.last_value = t.last_number`,
        [tenantId, VoucherType.INVOICE, ONBOARDING_SALE_SOURCE],
      );
      // Their events and deliveries go with them (ON DELETE CASCADE)
      const removed = await client.query(
        `DELETE FROM invoices WHERE tenant_id = $1 AND doc_type = $2 AND sale->>'source' = $3`,
        [tenantId, VoucherType.INVOICE, ONBOARDING_SALE_SOURCE],
      );
      await client.query(
        'UPDATE issuers SET environment = $2, updated_at = now() WHERE tenant_id = $1',
        [tenantId, Environment.PRODUCTION],
      );
      const result = {
        removedTestInvoices: removed.rowCount ?? 0,
        restoredSequences: restored.rowCount ?? 0,
      };
      await client.query(
        `INSERT INTO issuer_audit (tenant_id, action, actor_id, actor_name, detail)
         VALUES ($1, 'issuer.production_enabled', $2, $3, $4)`,
        [
          tenantId,
          actor.id,
          actor.username,
          JSON.stringify({
            environment: { from: Environment.TESTING, to: Environment.PRODUCTION },
            ...result,
          }),
        ],
      );
      return result;
    });
  }
}
