import { Certificate } from '../../domain/certificate';

export interface CertificateRow {
  id: string;
  serial_number: string;
  subject: string;
  issuer: string;
  valid_from: Date;
  valid_to: Date;
  file_name: string;
  p12_ciphertext: string;
  password_ciphertext: string | null;
  uploaded_at: Date;
}

export function toCertificateRow(cert: Certificate): CertificateRow {
  return {
    id: cert.id,
    serial_number: cert.serialNumber,
    subject: cert.subject,
    issuer: cert.issuer,
    valid_from: cert.validFrom,
    valid_to: cert.validTo,
    file_name: cert.fileName,
    p12_ciphertext: cert.p12Ciphertext,
    password_ciphertext: cert.passwordCiphertext,
    uploaded_at: cert.uploadedAt,
  };
}

export function fromCertificateRow(row: CertificateRow): Certificate {
  return new Certificate(
    row.id,
    row.serial_number,
    row.subject,
    row.issuer,
    row.valid_from,
    row.valid_to,
    row.file_name,
    row.p12_ciphertext,
    row.uploaded_at,
    row.password_ciphertext,
  );
}
