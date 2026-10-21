export enum Environment {
  TESTING = 1,
  PRODUCTION = 2,
}

export enum EmissionType {
  NORMAL = 1,
}

// Régimen RIMPE of the taxpayer, when it has one
export enum RimpeRegime {
  ENTREPRENEUR = 'EMPRENDEDOR',
  POPULAR_BUSINESS = 'NEGOCIO_POPULAR',
}

/**
 * The fiscal profile of a company (a faclab-core tenant, one RUC). The establishment, its address
 * and the emission point are not here: each sale brings the ones it was made at.
 */
export class CompanyConfig {
  constructor(
    public readonly tenantId: string,
    public readonly taxId: string,
    public readonly name: string,
    public readonly tradeName: string,
    public readonly mainAddress: string,
    public readonly specialTaxpayerResolution: string | null,
    public readonly withholdingAgentResolution: string | null,
    public readonly rimpeRegime: RimpeRegime | null,
    public readonly accountingRequired: boolean,
    public readonly environment: Environment,
    public readonly emissionType: EmissionType,
    public readonly signingCertId: string | null,
    public readonly updatedAt: Date,
  ) {}

  static create(props: {
    tenantId: string;
    taxId: string;
    name: string;
    tradeName: string;
    mainAddress: string;
    specialTaxpayerResolution?: string | null;
    withholdingAgentResolution?: string | null;
    rimpeRegime?: RimpeRegime | null;
    accountingRequired?: boolean;
    environment: Environment;
    emissionType: EmissionType;
    signingCertId?: string | null;
  }): CompanyConfig {
    return new CompanyConfig(
      props.tenantId,
      props.taxId,
      props.name,
      props.tradeName,
      props.mainAddress,
      props.specialTaxpayerResolution ?? null,
      props.withholdingAgentResolution ?? null,
      props.rimpeRegime ?? null,
      props.accountingRequired ?? false,
      props.environment,
      props.emissionType,
      props.signingCertId ?? null,
      new Date(),
    );
  }
}
