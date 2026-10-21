import { IssuerChangeListener } from '#/modules/company-config/domain/readiness';
import { CompanyConfigRepository } from '#/modules/company-config/domain/repository';
import { ConflictError, NotFoundError, ValidationError } from '#/shared/errors/app-error';

import { Certificate } from '../domain/certificate';
import { P12ParserPort, SecretCipherPort } from '../domain/ports';
import { CertificateRepository } from '../domain/repository';

export interface UploadCertificateInput {
  fileBuffer: Buffer;
  fileName: string;
  password: string;
}

export class UploadCertificateCommand {
  constructor(
    private readonly p12Parser: P12ParserPort,
    private readonly certificateRepository: CertificateRepository,
    private readonly cipher: SecretCipherPort,
    private readonly issuerListener: IssuerChangeListener,
  ) {}

  async execute(input: UploadCertificateInput): Promise<Certificate> {
    // Also checks the password: a wrong one can't open the file
    const metadata = this.p12Parser.parse(input.fileBuffer, input.password);
    if (metadata.validTo.getTime() <= Date.now()) {
      throw new ValidationError(`The certificate expired on ${metadata.validTo.toISOString()}`);
    }

    // The file and its password are saved together, both encrypted
    const certificate = Certificate.create({
      serialNumber: metadata.serialNumber,
      subject: metadata.subject,
      issuer: metadata.issuer,
      validFrom: metadata.validFrom,
      validTo: metadata.validTo,
      fileName: input.fileName,
      p12Ciphertext: this.cipher.encryptBytes(input.fileBuffer),
      passwordCiphertext: this.cipher.encrypt(input.password),
    });

    await this.certificateRepository.save(certificate);
    this.issuerListener.issuerChanged();
    return certificate;
  }
}

export class GetCertificateCommand {
  constructor(private readonly certificateRepository: CertificateRepository) {}

  async execute(id: string): Promise<Certificate | null> {
    return this.certificateRepository.findById(id);
  }
}

export class ListCertificatesCommand {
  constructor(private readonly certificateRepository: CertificateRepository) {}

  async execute(): Promise<Certificate[]> {
    return this.certificateRepository.findAll();
  }
}

export class DeleteCertificateCommand {
  constructor(
    private readonly certificateRepository: CertificateRepository,
    private readonly companyConfigRepository: CompanyConfigRepository,
    private readonly issuerListener: IssuerChangeListener,
  ) {}

  async execute(id: string): Promise<void> {
    const certificate = await this.certificateRepository.findById(id);
    if (!certificate) {
      throw new NotFoundError(`Certificate with id ${id} not found`);
    }

    const config = await this.companyConfigRepository.find();
    if (config?.signingCertId === id) {
      throw new ConflictError(
        'CERTIFICATE_IN_USE',
        'The certificate is selected in the company config: choose another one first',
      );
    }

    await this.certificateRepository.delete(id);
    this.issuerListener.issuerChanged();
  }
}
