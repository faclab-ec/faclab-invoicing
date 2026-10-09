import { CertificateKeyLoader } from '#/modules/certificate/app/certificate-key-loader';
import { IssuerReadinessService } from '#/modules/company-config/app/issuer-readiness';
import { IssuerNotReadyError } from '#/modules/company-config/domain/readiness';

import { InvoiceSignerPort } from '../../domain/ports';
import { P12Reader, SigningCredentials } from '../signing/p12-reader';
import { XadesSigner } from '../signing/xades-signer';

export class SignerAdapter implements InvoiceSignerPort {
  private credentials: SigningCredentials | null = null;
  private cachedCertificateId: string | null = null;

  constructor(
    private readonly readiness: IssuerReadinessService,
    private readonly keyLoader: CertificateKeyLoader,
    private readonly xadesSigner: XadesSigner,
  ) {}

  async signInvoice(xml: string): Promise<string> {
    const credentials = await this.getCredentials();
    return this.xadesSigner.sign(xml, credentials);
  }

  private async getCredentials(): Promise<SigningCredentials> {
    // Signs with the certificate selected now, which may differ from the one
    // the invoice was prepared with
    const { certificate } = await this.readiness.requireReady();
    if (this.credentials && this.cachedCertificateId === certificate.id) return this.credentials;

    try {
      const key = await this.keyLoader.load(certificate);
      this.credentials = new P12Reader(key.p12, key.password).getCredentials();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new IssuerNotReadyError(
        'CERTIFICATE_UNREADABLE',
        `The signing certificate can't be opened: ${reason}`,
      );
    }
    this.cachedCertificateId = certificate.id;
    return this.credentials;
  }
}
