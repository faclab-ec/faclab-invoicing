import { Pool } from 'pg';
import { validate as isUuid } from 'uuid';

import { Certificate } from '../../domain/certificate';
import { CertificateRepository } from '../../domain/repository';
import { CertificateRow, fromCertificateRow, toCertificateRow } from './certificate.mapper';

// Every query names the company: a certificate of another one is never read nor deleted
export class PgCertificateRepository implements CertificateRepository {
  constructor(private readonly pool: Pool) {}

  async save(certificate: Certificate): Promise<Certificate> {
    const row = toCertificateRow(certificate);
    // The company of a certificate never changes: an update only applies within it
    await this.pool.query(
      `INSERT INTO certificates (
         id, tenant_id, serial_number, subject, issuer, tax_ids, valid_from, valid_to, file_name,
         p12_ciphertext, password_ciphertext, uploaded_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO UPDATE SET
         serial_number = EXCLUDED.serial_number,
         subject = EXCLUDED.subject,
         issuer = EXCLUDED.issuer,
         tax_ids = EXCLUDED.tax_ids,
         valid_from = EXCLUDED.valid_from,
         valid_to = EXCLUDED.valid_to,
         file_name = EXCLUDED.file_name,
         p12_ciphertext = EXCLUDED.p12_ciphertext,
         password_ciphertext = EXCLUDED.password_ciphertext,
         uploaded_at = EXCLUDED.uploaded_at
       WHERE certificates.tenant_id = EXCLUDED.tenant_id`,
      [
        row.id,
        row.tenant_id,
        row.serial_number,
        row.subject,
        row.issuer,
        row.tax_ids,
        row.valid_from,
        row.valid_to,
        row.file_name,
        row.p12_ciphertext,
        row.password_ciphertext,
        row.uploaded_at,
      ],
    );
    return certificate;
  }

  async findById(tenantId: string, id: string): Promise<Certificate | null> {
    // Not a uuid: no certificate has it (and the query would fail on the cast)
    if (!isUuid(id)) return null;
    const result = await this.pool.query<CertificateRow>(
      'SELECT * FROM certificates WHERE tenant_id = $1 AND id = $2',
      [tenantId, id],
    );
    return result.rows[0] ? fromCertificateRow(result.rows[0]) : null;
  }

  async findAll(tenantId: string): Promise<Certificate[]> {
    const result = await this.pool.query<CertificateRow>(
      'SELECT * FROM certificates WHERE tenant_id = $1 ORDER BY uploaded_at DESC, id',
      [tenantId],
    );
    return result.rows.map(fromCertificateRow);
  }

  async delete(tenantId: string, id: string): Promise<void> {
    if (!isUuid(id)) return;
    await this.pool.query('DELETE FROM certificates WHERE tenant_id = $1 AND id = $2', [
      tenantId,
      id,
    ]);
  }
}
