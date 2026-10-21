import { certificateRucMismatch } from '#/modules/certificate/app/certificate.commands';
import { CertificateRepository } from '#/modules/certificate/domain/repository';
import { ValidationError } from '#/shared/errors/app-error';

import { CompanyConfig, EmissionType, Environment, RimpeRegime } from '../domain/company-config';
import { IssuerChangeListener } from '../domain/readiness';
import { CompanyConfigRepository } from '../domain/repository';

export interface SaveCompanyConfigInput {
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
}

export class SaveCompanyConfigCommand {
  constructor(
    private readonly repository: CompanyConfigRepository,
    private readonly certificateRepository: CertificateRepository,
    private readonly issuerListener: IssuerChangeListener,
  ) {}

  /**
   * Saves the company's fiscal profile. Only the fields of the profile count: the establishment,
   * the emission point and the sequence that faclab-web still sends (until S2.9) are ignored, so
   * saving it never moves a counter.
   */
  async execute(tenantId: string, input: SaveCompanyConfigInput): Promise<CompanyConfig> {
    if (input.signingCertId) {
      const certificate = await this.certificateRepository.findById(tenantId, input.signingCertId);
      if (!certificate) {
        throw new ValidationError(`Signing certificate ${input.signingCertId} not found`);
      }
      // Also when the RUC changes with a certificate selected
      if (!certificate.belongsTo(input.taxId)) {
        throw certificateRucMismatch(certificate.taxIds, input.taxId);
      }
    }

    const config = CompanyConfig.create({
      tenantId,
      taxId: input.taxId,
      name: input.name,
      tradeName: input.tradeName,
      mainAddress: input.mainAddress,
      specialTaxpayerResolution: input.specialTaxpayerResolution,
      withholdingAgentResolution: input.withholdingAgentResolution,
      rimpeRegime: input.rimpeRegime,
      accountingRequired: input.accountingRequired,
      environment: input.environment,
      emissionType: input.emissionType,
      signingCertId: input.signingCertId,
    });
    await this.repository.save(config);
    this.issuerListener.issuerChanged(tenantId);
    return config;
  }
}

export class GetCompanyConfigQuery {
  constructor(private readonly repository: CompanyConfigRepository) {}

  async execute(tenantId: string): Promise<CompanyConfig | null> {
    return this.repository.find(tenantId);
  }
}
