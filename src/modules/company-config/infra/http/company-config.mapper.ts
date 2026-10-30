import { CompanyConfig } from '../../domain/company-config';
import { formatSequence, Sequence } from '../../domain/sequence';

export function toResponse(config: CompanyConfig) {
  return {
    taxId: config.taxId,
    name: config.name,
    tradeName: config.tradeName,
    mainAddress: config.mainAddress,
    specialTaxpayerResolution: config.specialTaxpayerResolution,
    withholdingAgentResolution: config.withholdingAgentResolution,
    rimpeRegime: config.rimpeRegime,
    accountingRequired: config.accountingRequired,
    environment: config.environment,
    emissionType: config.emissionType,
    signingCertId: config.signingCertId,
    email: config.email,
    hasLogo: config.logo !== null,
    updatedAt: config.updatedAt.toISOString(),
  };
}

export function toSequenceResponse(sequence: Sequence) {
  return {
    establishment: sequence.establishment,
    emissionPoint: sequence.emissionPoint,
    docType: sequence.docType,
    lastSequence: sequence.lastValue === 0 ? null : formatSequence(sequence.lastValue),
    nextSequence: sequence.lastValue + 1,
  };
}
