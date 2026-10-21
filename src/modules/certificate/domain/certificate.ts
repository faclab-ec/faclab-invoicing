import { randomUUID } from 'crypto';

/** Whether a certificate's RUCs or cédulas name the taxpayer with this RUC */
export function taxIdsMatch(taxIds: readonly string[], ruc: string): boolean {
  // A natural person's RUC is their cédula followed by 001
  return taxIds.some((taxId) => taxId === ruc || (taxId.length === 10 && `${taxId}001` === ruc));
}

export class Certificate {
  constructor(
    public readonly id: string,
    // The company that uploaded it: only its issuer signs with it
    public readonly tenantId: string,
    public readonly serialNumber: string,
    public readonly subject: string,
    public readonly issuer: string,
    // RUCs and cédulas found in the certificate
    public readonly taxIds: string[],
    public readonly validFrom: Date,
    public readonly validTo: Date,
    public readonly fileName: string,
    // The .p12 file, encrypted
    public readonly p12Ciphertext: string,
    public readonly uploadedAt: Date,
    // The .p12 password, encrypted. Null for certificates uploaded before it
    // was stored: those can't sign until they are uploaded again
    public readonly passwordCiphertext: string | null,
  ) {}

  static create(props: {
    tenantId: string;
    serialNumber: string;
    subject: string;
    issuer: string;
    taxIds: string[];
    validFrom: Date;
    validTo: Date;
    fileName: string;
    p12Ciphertext: string;
    passwordCiphertext: string;
  }): Certificate {
    return new Certificate(
      randomUUID(),
      props.tenantId,
      props.serialNumber,
      props.subject,
      props.issuer,
      props.taxIds,
      props.validFrom,
      props.validTo,
      props.fileName,
      props.p12Ciphertext,
      new Date(),
      props.passwordCiphertext,
    );
  }

  isExpired(now: Date = new Date()): boolean {
    return this.validTo.getTime() <= now.getTime();
  }

  /** Whether it is a certificate of the taxpayer with this RUC */
  belongsTo(ruc: string): boolean {
    return taxIdsMatch(this.taxIds, ruc);
  }
}
