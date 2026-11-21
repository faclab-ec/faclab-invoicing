import { Certificate } from './certificate';

/** The certificate a company's issuer signs with */
export interface SelectedCertificate {
  tenantId: string;
  certificateId: string;
  validTo: Date;
}

/** The certificates the issuers sign with, across companies (the expiry report) */
export interface SigningCertificates {
  listSelected(): Promise<SelectedCertificate[]>;
}

/** A company's certificates: another company's id is not found */
export interface CertificateRepository {
  save(certificate: Certificate): Promise<Certificate>;
  findById(tenantId: string, id: string): Promise<Certificate | null>;
  findAll(tenantId: string): Promise<Certificate[]>;
  delete(tenantId: string, id: string): Promise<void>;
}
