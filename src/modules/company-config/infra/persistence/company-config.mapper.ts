import { CompanyConfig, EmissionType, Environment } from '../../domain/company-config';

/** A row of `issuers`, joined with the `last_value` of its invoice sequence */
export interface CompanyConfigRow {
  id: string;
  tax_id: string;
  name: string;
  trade_name: string;
  main_address: string;
  branch_address: string;
  branch_code: string;
  sale_point_code: string;
  special_taxpayer_resolution: string | null;
  withholding_agent_resolution: string | null;
  accounting_required: boolean;
  environment: number;
  emission_type: number;
  signing_cert_id: string | null;
  updated_at: Date;
  // bigint: pg returns it as a string
  last_invoice_sequence: string | null;
}

export function toCompanyConfigRow(
  config: CompanyConfig,
): Omit<CompanyConfigRow, 'last_invoice_sequence'> {
  return {
    id: config.id,
    tax_id: config.taxId,
    name: config.name,
    trade_name: config.tradeName,
    main_address: config.mainAddress,
    branch_address: config.branchAddress,
    branch_code: config.branchCode,
    sale_point_code: config.salePointCode,
    special_taxpayer_resolution: config.specialTaxpayerResolution,
    withholding_agent_resolution: config.withholdingAgentResolution,
    accounting_required: config.accountingRequired,
    environment: config.environment,
    emission_type: config.emissionType,
    signing_cert_id: config.signingCertId,
    updated_at: config.updatedAt,
  };
}

export function fromCompanyConfigRow(row: CompanyConfigRow): CompanyConfig {
  return new CompanyConfig(
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
    row.environment as Environment,
    row.emission_type as EmissionType,
    Number(row.last_invoice_sequence ?? 0) + 1,
    row.signing_cert_id,
    row.updated_at,
  );
}
