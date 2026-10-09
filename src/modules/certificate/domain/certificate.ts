import { randomUUID } from 'crypto';

export class Certificate {
  constructor(
    public readonly id: string,
    public readonly serialNumber: string,
    public readonly subject: string,
    public readonly issuer: string,
    public readonly validFrom: Date,
    public readonly validTo: Date,
    public readonly fileName: string,
    public readonly s3Key: string,
    public readonly s3Url: string,
    public readonly uploadedAt: Date,
    // The .p12 password, encrypted. Null for certificates uploaded before it
    // was stored: those can't sign until they are uploaded again
    public readonly passwordCiphertext: string | null,
  ) {}

  static create(props: {
    serialNumber: string;
    subject: string;
    issuer: string;
    validFrom: Date;
    validTo: Date;
    fileName: string;
    s3Key: string;
    s3Url: string;
    passwordCiphertext: string;
  }): Certificate {
    return new Certificate(
      randomUUID(),
      props.serialNumber,
      props.subject,
      props.issuer,
      props.validFrom,
      props.validTo,
      props.fileName,
      props.s3Key,
      props.s3Url,
      new Date(),
      props.passwordCiphertext,
    );
  }

  isExpired(now: Date = new Date()): boolean {
    return this.validTo.getTime() <= now.getTime();
  }
}
