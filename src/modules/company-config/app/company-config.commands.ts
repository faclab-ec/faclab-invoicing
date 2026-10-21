import { CertificateRepository } from '#/modules/certificate/domain/repository';
import { ValidationError } from '#/shared/errors/app-error';

import { CompanyConfig, EmissionType, Environment } from '../domain/company-config';
import { IssuerChangeListener } from '../domain/readiness';
import { CompanyConfigRepository } from '../domain/repository';

export interface SaveCompanyConfigInput {
  taxId: string;
  name: string;
  tradeName: string;
  mainAddress: string;
  branchAddress: string;
  branchCode: string;
  salePointCode: string;
  specialTaxpayerResolution?: string | null;
  withholdingAgentResolution?: string | null;
  accountingRequired?: boolean;
  environment: Environment;
  emissionType: EmissionType;
  invoiceSequence?: number;
  signingCertId?: string | null;
}

export class SaveCompanyConfigCommand {
  constructor(
    private readonly repository: CompanyConfigRepository,
    private readonly certificateRepository: CertificateRepository,
    private readonly issuerListener: IssuerChangeListener,
  ) {}

  async execute(input: SaveCompanyConfigInput): Promise<CompanyConfig> {
    if (input.signingCertId) {
      const certificate = await this.certificateRepository.findById(input.signingCertId);
      if (!certificate) {
        throw new ValidationError(`Signing certificate ${input.signingCertId} not found`);
      }
    }

    const config = CompanyConfig.create(input);
    await this.repository.save(config);
    // Only an explicit value moves the counter: saving the rest of the config leaves it alone
    if (input.invoiceSequence !== undefined) {
      await this.repository.setNextInvoiceSequence(input.invoiceSequence);
    }
    this.issuerListener.issuerChanged();
    // With the sequence as it is now
    return (await this.repository.find()) ?? config;
  }
}

export class GetCompanyConfigQuery {
  constructor(private readonly repository: CompanyConfigRepository) {}

  async execute(): Promise<CompanyConfig | null> {
    return this.repository.find();
  }
}
