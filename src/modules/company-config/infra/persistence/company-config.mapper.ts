import { CompanyConfig, EmissionType, Environment, RimpeRegime } from '../../domain/company-config';

/** A row of `issuers`: the fiscal profile of a company */
export interface CompanyConfigRow {
  tenant_id: string;
  tax_id: string;
  name: string;
  trade_name: string;
  main_address: string;
  special_taxpayer_resolution: string | null;
  withholding_agent_resolution: string | null;
  rimpe_regime: string | null;
  accounting_required: boolean;
  environment: number;
  emission_type: number;
  signing_cert_id: string | null;
  updated_at: Date;
}

export function toCompanyConfigRow(config: CompanyConfig): CompanyConfigRow {
  return {
    tenant_id: config.tenantId,
    tax_id: config.taxId,
    name: config.name,
    trade_name: config.tradeName,
    main_address: config.mainAddress,
    special_taxpayer_resolution: config.specialTaxpayerResolution,
    withholding_agent_resolution: config.withholdingAgentResolution,
    rimpe_regime: config.rimpeRegime,
    accounting_required: config.accountingRequired,
    environment: config.environment,
    emission_type: config.emissionType,
    signing_cert_id: config.signingCertId,
    updated_at: config.updatedAt,
  };
}

export function fromCompanyConfigRow(row: CompanyConfigRow): CompanyConfig {
  return new CompanyConfig(
    row.tenant_id,
    row.tax_id,
    row.name,
    row.trade_name,
    row.main_address,
    row.special_taxpayer_resolution,
    row.withholding_agent_resolution,
    row.rimpe_regime as RimpeRegime | null,
    row.accounting_required,
    row.environment as Environment,
    row.emission_type as EmissionType,
    row.signing_cert_id,
    row.updated_at,
  );
}
