import { Pool } from 'pg';

import { CompanyConfig } from '../../domain/company-config';
import { CompanyConfigRepository } from '../../domain/repository';
import {
  CompanyConfigRow,
  fromCompanyConfigRow,
  toCompanyConfigRow,
} from './company-config.mapper';

/** One row per company in `issuers`, keyed by its tenant id */
export class PgCompanyConfigRepository implements CompanyConfigRepository {
  constructor(private readonly pool: Pool) {}

  async save(config: CompanyConfig): Promise<CompanyConfig> {
    const row = toCompanyConfigRow(config);
    await this.pool.query(
      `INSERT INTO issuers (
         tenant_id, tax_id, name, trade_name, main_address, special_taxpayer_resolution,
         withholding_agent_resolution, rimpe_regime, accounting_required, environment,
         emission_type, signing_cert_id, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (tenant_id) DO UPDATE SET
         tax_id = EXCLUDED.tax_id,
         name = EXCLUDED.name,
         trade_name = EXCLUDED.trade_name,
         main_address = EXCLUDED.main_address,
         special_taxpayer_resolution = EXCLUDED.special_taxpayer_resolution,
         withholding_agent_resolution = EXCLUDED.withholding_agent_resolution,
         rimpe_regime = EXCLUDED.rimpe_regime,
         accounting_required = EXCLUDED.accounting_required,
         environment = EXCLUDED.environment,
         emission_type = EXCLUDED.emission_type,
         signing_cert_id = EXCLUDED.signing_cert_id,
         updated_at = EXCLUDED.updated_at`,
      [
        row.tenant_id,
        row.tax_id,
        row.name,
        row.trade_name,
        row.main_address,
        row.special_taxpayer_resolution,
        row.withholding_agent_resolution,
        row.rimpe_regime,
        row.accounting_required,
        row.environment,
        row.emission_type,
        row.signing_cert_id,
        row.updated_at,
      ],
    );
    return config;
  }

  async find(tenantId: string): Promise<CompanyConfig | null> {
    const result = await this.pool.query<CompanyConfigRow>(
      'SELECT * FROM issuers WHERE tenant_id = $1',
      [tenantId],
    );
    return result.rows[0] ? fromCompanyConfigRow(result.rows[0]) : null;
  }
}
