import { Certificate } from '../../domain/certificate';

export interface CertificateRecord {
  id: string;
  serial_number: string;
  subject: string;
  issuer: string;
  valid_from: string;
  valid_to: string;
  file_name: string;
  s3_key: string;
  s3_url: string;
  uploaded_at: string;
  password_ciphertext?: string | null;
}

export function toCertificateRecord(cert: Certificate): CertificateRecord {
  return {
    id: cert.id,
    serial_number: cert.serialNumber,
    subject: cert.subject,
    issuer: cert.issuer,
    valid_from: cert.validFrom.toISOString(),
    valid_to: cert.validTo.toISOString(),
    file_name: cert.fileName,
    s3_key: cert.s3Key,
    s3_url: cert.s3Url,
    uploaded_at: cert.uploadedAt.toISOString(),
    password_ciphertext: cert.passwordCiphertext,
  };
}

export function fromCertificateRecord(record: CertificateRecord): Certificate {
  return new Certificate(
    record.id,
    record.serial_number,
    record.subject,
    record.issuer,
    new Date(record.valid_from),
    new Date(record.valid_to),
    record.file_name,
    record.s3_key,
    record.s3_url,
    new Date(record.uploaded_at),
    record.password_ciphertext ?? null,
  );
}
