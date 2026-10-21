import { Pool } from 'pg';
import { validate as isUuid } from 'uuid';

import { Certificate } from '../../domain/certificate';
import { CertificateRepository } from '../../domain/repository';
import { CertificateRow, fromCertificateRow, toCertificateRow } from './certificate.mapper';

export class PgCertificateRepository implements CertificateRepository {
  constructor(private readonly pool: Pool) {}

  async save(certificate: Certificate): Promise<Certificate> {
    const row = toCertificateRow(certificate);
    await this.pool.query(
      `INSERT INTO certificates (
         id, serial_number, subject, issuer, valid_from, valid_to, file_name, p12_ciphertext,
         password_ciphertext, uploaded_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET
         serial_number = EXCLUDED.serial_number,
         subject = EXCLUDED.subject,
         issuer = EXCLUDED.issuer,
         valid_from = EXCLUDED.valid_from,
         valid_to = EXCLUDED.valid_to,
         file_name = EXCLUDED.file_name,
         p12_ciphertext = EXCLUDED.p12_ciphertext,
         password_ciphertext = EXCLUDED.password_ciphertext,
         uploaded_at = EXCLUDED.uploaded_at`,
      [
        row.id,
        row.serial_number,
        row.subject,
        row.issuer,
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

  async findById(id: string): Promise<Certificate | null> {
    // Not a uuid: no certificate has it (and the query would fail on the cast)
    if (!isUuid(id)) return null;
    const result = await this.pool.query<CertificateRow>(
      'SELECT * FROM certificates WHERE id = $1',
      [id],
    );
    return result.rows[0] ? fromCertificateRow(result.rows[0]) : null;
  }

  async findAll(): Promise<Certificate[]> {
    const result = await this.pool.query<CertificateRow>(
      'SELECT * FROM certificates ORDER BY uploaded_at DESC, id',
    );
    return result.rows.map(fromCertificateRow);
  }

  async findBySerialNumber(serialNumber: string): Promise<Certificate | null> {
    const result = await this.pool.query<CertificateRow>(
      'SELECT * FROM certificates WHERE serial_number = $1 ORDER BY uploaded_at DESC LIMIT 1',
      [serialNumber],
    );
    return result.rows[0] ? fromCertificateRow(result.rows[0]) : null;
  }

  async delete(id: string): Promise<void> {
    if (!isUuid(id)) return;
    await this.pool.query('DELETE FROM certificates WHERE id = $1', [id]);
  }
}
