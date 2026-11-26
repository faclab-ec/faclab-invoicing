import { trace } from '@opentelemetry/api';

import { CertificateKeyLoader } from '#/modules/certificate/app/certificate-key-loader';
import { IssuerReadinessService } from '#/modules/company-config/app/issuer-readiness';
import { IssuerNotReadyError } from '#/modules/company-config/domain/readiness';
import { VoucherType } from '#/modules/company-config/domain/sequence';
import { errorType } from '#/shared/telemetry/attributes';
import { failSpan } from '#/shared/telemetry/spans';

import { InvoiceSignerPort } from '../../domain/ports';
import { P12Reader, SigningCredentials } from '../signing/p12-reader';
import { XadesSigner } from '../signing/xades-signer';
import { documentTypeLabel } from '../telemetry/attributes';

const tracer = trace.getTracer('faclab-invoicing.signing');

export class SignerAdapter implements InvoiceSignerPort {
  // Loaded credentials by certificate id: each company signs with its own
  private readonly credentials = new Map<string, SigningCredentials>();

  constructor(
    private readonly readiness: IssuerReadinessService,
    private readonly keyLoader: CertificateKeyLoader,
    private readonly xadesSigner: XadesSigner,
  ) {}

  /** In an `invoice.sign` span (OBSERVABILITY.md §5.2): neither the XML nor the key go into it */
  async signInvoice(xml: string, tenantId: string, docType: VoucherType): Promise<string> {
    return tracer.startActiveSpan(
      'invoice.sign',
      { attributes: { 'faclab.document.type': documentTypeLabel(docType) } },
      async (span) => {
        try {
          const credentials = await this.getCredentials(tenantId);
          return this.xadesSigner.sign(xml, credentials);
        } catch (error) {
          span.setAttribute('error.type', errorType(error));
          failSpan(span, error);
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  private async getCredentials(tenantId: string): Promise<SigningCredentials> {
    // Signs with the certificate the company's issuer selects now, which may differ from the one
    // the invoice was prepared with
    const { certificate } = await this.readiness.requireReady(tenantId);
    const cached = this.credentials.get(certificate.id);
    if (cached) return cached;

    let credentials: SigningCredentials;
    try {
      const key = await this.keyLoader.load(certificate);
      credentials = new P12Reader(key.p12, key.password).getCredentials();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new IssuerNotReadyError(
        'CERTIFICATE_UNREADABLE',
        `The signing certificate can't be opened: ${reason}`,
      );
    }
    this.credentials.set(certificate.id, credentials);
    return credentials;
  }
}
