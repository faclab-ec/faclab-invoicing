import { IssuerChangeListener } from '#/modules/company-config/domain/readiness';
import { CompanyConfigRepository } from '#/modules/company-config/domain/repository';
import {
  ConflictError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from '#/shared/errors/app-error';

import { Certificate, taxIdsMatch } from '../domain/certificate';
import { P12ParserPort, SecretCipherPort } from '../domain/ports';
import { CertificateRepository } from '../domain/repository';

export interface UploadCertificateInput {
  fileBuffer: Buffer;
  fileName: string;
  password: string;
}

/** The certificate names no RUC or cédula: it can't be checked against the issuer */
export function certificateRucUnknown(): UnprocessableError {
  return new UnprocessableError(
    'CERTIFICATE_RUC_UNKNOWN',
    "The certificate doesn't name a RUC or a cédula, so it can't be checked against the issuer's RUC",
  );
}

/** The certificate is of another taxpayer: the SRI would reject what it signs */
export function certificateRucMismatch(taxIds: readonly string[], ruc: string): UnprocessableError {
  return new UnprocessableError(
    'CERTIFICATE_RUC_MISMATCH',
    `The certificate belongs to ${taxIds.join(', ')}, not to the issuer's RUC ${ruc}`,
  );
}

export class UploadCertificateCommand {
  constructor(
    private readonly p12Parser: P12ParserPort,
    private readonly certificateRepository: CertificateRepository,
    private readonly companyConfigRepository: CompanyConfigRepository,
    private readonly cipher: SecretCipherPort,
    private readonly issuerListener: IssuerChangeListener,
  ) {}

  async execute(tenantId: string, input: UploadCertificateInput): Promise<Certificate> {
    // The certificate is checked against the issuer's RUC: the profile comes first
    const config = await this.companyConfigRepository.find(tenantId);
    if (!config) {
      throw new ConflictError(
        'ISSUER_NOT_CONFIGURED',
        'Save the company fiscal profile (PUT /api/company-config) before uploading its certificate',
      );
    }

    // Also checks the password: a wrong one can't open the file
    const metadata = this.p12Parser.parse(input.fileBuffer, input.password);
    if (metadata.validTo.getTime() <= Date.now()) {
      throw new ValidationError(`The certificate expired on ${metadata.validTo.toISOString()}`);
    }
    if (metadata.taxIds.length === 0) throw certificateRucUnknown();
    if (!taxIdsMatch(metadata.taxIds, config.taxId)) {
      throw certificateRucMismatch(metadata.taxIds, config.taxId);
    }

    // The file and its password are saved together, both encrypted
    const certificate = Certificate.create({
      tenantId,
      serialNumber: metadata.serialNumber,
      subject: metadata.subject,
      issuer: metadata.issuer,
      taxIds: metadata.taxIds,
      validFrom: metadata.validFrom,
      validTo: metadata.validTo,
      fileName: input.fileName,
      p12Ciphertext: this.cipher.encryptBytes(input.fileBuffer),
      passwordCiphertext: this.cipher.encrypt(input.password),
    });

    await this.certificateRepository.save(certificate);
    this.issuerListener.issuerChanged(tenantId);
    return certificate;
  }
}

export class GetCertificateCommand {
  constructor(private readonly certificateRepository: CertificateRepository) {}

  async execute(tenantId: string, id: string): Promise<Certificate | null> {
    return this.certificateRepository.findById(tenantId, id);
  }
}

export class ListCertificatesCommand {
  constructor(private readonly certificateRepository: CertificateRepository) {}

  async execute(tenantId: string): Promise<Certificate[]> {
    return this.certificateRepository.findAll(tenantId);
  }
}

export class DeleteCertificateCommand {
  constructor(
    private readonly certificateRepository: CertificateRepository,
    private readonly companyConfigRepository: CompanyConfigRepository,
    private readonly issuerListener: IssuerChangeListener,
  ) {}

  async execute(tenantId: string, id: string): Promise<void> {
    const certificate = await this.certificateRepository.findById(tenantId, id);
    if (!certificate) {
      throw new NotFoundError(`Certificate with id ${id} not found`);
    }

    const config = await this.companyConfigRepository.find(tenantId);
    if (config?.signingCertId === id) {
      throw new ConflictError(
        'CERTIFICATE_IN_USE',
        'The certificate is selected in the company config: choose another one first',
      );
    }

    await this.certificateRepository.delete(tenantId, id);
    this.issuerListener.issuerChanged(tenantId);
  }
}
