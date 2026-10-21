import { Pool } from 'pg';

import { CompanyConfig } from '../../domain/company-config';
import { CompanyConfigRepository } from '../../domain/repository';
import {
  CompanyConfigRow,
  fromCompanyConfigRow,
  toCompanyConfigRow,
} from './company-config.mapper';

// `sequences` row of the invoices (SRI document code 01); the initial migration creates it
const INVOICE_DOC_TYPE = '01';

export class PgCompanyConfigRepository implements CompanyConfigRepository {
  constructor(private readonly pool: Pool) {}

  async save(config: CompanyConfig): Promise<CompanyConfig> {
    const row = toCompanyConfigRow(config);
    await this.pool.query(
      `INSERT INTO issuers (
         id, tax_id, name, trade_name, main_address, branch_address, branch_code,
         sale_point_code, special_taxpayer_resolution, withholding_agent_resolution,
         accounting_required, environment, emission_type, signing_cert_id, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (id) DO UPDATE SET
         tax_id = EXCLUDED.tax_id,
         name = EXCLUDED.name,
         trade_name = EXCLUDED.trade_name,
         main_address = EXCLUDED.main_address,
         branch_address = EXCLUDED.branch_address,
         branch_code = EXCLUDED.branch_code,
         sale_point_code = EXCLUDED.sale_point_code,
         special_taxpayer_resolution = EXCLUDED.special_taxpayer_resolution,
         withholding_agent_resolution = EXCLUDED.withholding_agent_resolution,
         accounting_required = EXCLUDED.accounting_required,
         environment = EXCLUDED.environment,
         emission_type = EXCLUDED.emission_type,
         signing_cert_id = EXCLUDED.signing_cert_id,
         updated_at = EXCLUDED.updated_at`,
      [
        row.id,
        row.tax_id,
        row.name,
        row.trade_name,
        row.main_address,
        row.branch_address,
        row.branch_code,
        row.sale_point_code,
        row.special_taxpayer_resolution,
        row.withholding_agent_resolution,
        row.accounting_required,
        row.environment,
        row.emission_type,
        row.signing_cert_id,
        row.updated_at,
      ],
    );
    return config;
  }

  async find(): Promise<CompanyConfig | null> {
    const result = await this.pool.query<CompanyConfigRow>(
      `SELECT i.*, s.last_value AS last_invoice_sequence
       FROM issuers i
       LEFT JOIN sequences s ON s.doc_type = $2
       WHERE i.id = $1`,
      [CompanyConfig.SINGLETON_ID, INVOICE_DOC_TYPE],
    );
    return result.rows[0] ? fromCompanyConfigRow(result.rows[0]) : null;
  }

  async nextInvoiceSequence(): Promise<number> {
    // The row lock makes concurrent callers take consecutive numbers
    const result = await this.pool.query<{ last_value: string }>(
      `UPDATE sequences SET last_value = last_value + 1
       WHERE doc_type = $1
       RETURNING last_value`,
      [INVOICE_DOC_TYPE],
    );
    if (!result.rows[0]) {
      throw new Error('The invoice sequence row is missing: run the database migrations');
    }
    return Number(result.rows[0].last_value);
  }

  async setNextInvoiceSequence(next: number): Promise<void> {
    await this.pool.query(`UPDATE sequences SET last_value = $2 WHERE doc_type = $1`, [
      INVOICE_DOC_TYPE,
      next - 1,
    ]);
  }
}
