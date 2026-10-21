import { Certificate } from '../../domain/certificate';

export function toResponse(cert: Certificate) {
  return {
    id: cert.id,
    serialNumber: cert.serialNumber,
    subject: cert.subject,
    issuer: cert.issuer,
    taxIds: cert.taxIds,
    validFrom: cert.validFrom.toISOString(),
    validTo: cert.validTo.toISOString(),
    fileName: cert.fileName,
    uploadedAt: cert.uploadedAt.toISOString(),
  };
}
