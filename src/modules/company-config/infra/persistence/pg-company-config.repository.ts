import { Pool } from 'pg';

import { CompanyConfig, IssuerLogo } from '../../domain/company-config';
import { CompanyConfigRepository } from '../../domain/repository';
import {
  CompanyConfigRow,
  fromCompanyConfigRow,
  toCompanyConfigRow,
} from './company-config.mapper';

/** One row per company in `issuers`, keyed by its tenant id */
export class PgCompanyConfigRepository implements CompanyConfigRepository {
  constructor(private readonly pool: Pool) {}

  // The logo is uploaded apart: saving the profile keeps it
  async save(config: CompanyConfig): Promise<CompanyConfig> {
    const row = toCompanyConfigRow(config);
    const result = await this.pool.query<CompanyConfigRow>(
      `INSERT INTO issuers (
         tenant_id, tax_id, name, trade_name, main_address, special_taxpayer_resolution,
         withholding_agent_resolution, rimpe_regime, accounting_required, environment,
         emission_type, signing_cert_id, updated_at, email
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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
         updated_at = EXCLUDED.updated_at,
         email = EXCLUDED.email
       RETURNING *`,
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
        row.email,
      ],
    );
    return fromCompanyConfigRow(result.rows[0]);
  }

  async find(tenantId: string): Promise<CompanyConfig | null> {
    const result = await this.pool.query<CompanyConfigRow>(
      'SELECT * FROM issuers WHERE tenant_id = $1',
      [tenantId],
    );
    return result.rows[0] ? fromCompanyConfigRow(result.rows[0]) : null;
  }

  async setLogo(tenantId: string, logo: IssuerLogo): Promise<CompanyConfig | null> {
    const result = await this.pool.query<CompanyConfigRow>(
      `UPDATE issuers SET logo_key = $2, logo_content_type = $3, updated_at = now()
       WHERE tenant_id = $1 RETURNING *`,
      [tenantId, logo.key, logo.contentType],
    );
    return result.rows[0] ? fromCompanyConfigRow(result.rows[0]) : null;
  }

  async clearLogo(tenantId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE issuers SET logo_key = NULL, logo_content_type = NULL, updated_at = now()
       WHERE tenant_id = $1 AND logo_key IS NOT NULL`,
      [tenantId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
