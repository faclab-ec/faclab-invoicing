import { Certificate } from './certificate';

/** A company's certificates: another company's id is not found */
export interface CertificateRepository {
  save(certificate: Certificate): Promise<Certificate>;
  findById(tenantId: string, id: string): Promise<Certificate | null>;
  findAll(tenantId: string): Promise<Certificate[]>;
  delete(tenantId: string, id: string): Promise<void>;
}
