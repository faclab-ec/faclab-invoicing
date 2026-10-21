import { randomBytes, randomUUID } from 'crypto';
import { expect, it, vi } from 'vitest';

import { UploadCertificateCommand } from '#/modules/certificate/app/certificate.commands';
import { CertificateKeyLoader } from '#/modules/certificate/app/certificate-key-loader';
import { Certificate } from '#/modules/certificate/domain/certificate';
import { P12ParserPort } from '#/modules/certificate/domain/ports';
import { PgCertificateRepository } from '#/modules/certificate/infra/persistence/pg-certificate.repository';
import { SaveCompanyConfigCommand } from '#/modules/company-config/app/company-config.commands';
import { EmissionType, Environment } from '#/modules/company-config/domain/company-config';
import { PgCompanyConfigRepository } from '#/modules/company-config/infra/persistence/pg-company-config.repository';
import { AesGcmSecretCipher } from '#/shared/infra/secret-cipher';

import { makeCertificate, makeConfig } from '../helpers';
import { describePostgres, usePostgres } from './support';

const CONFIG_INPUT = {
  taxId: '1792141001001',
  name: 'ACME S.A.',
  tradeName: 'ACME',
  mainAddress: 'Quito',
  branchAddress: 'Quito',
  branchCode: '001',
  salePointCode: '001',
  environment: Environment.TESTING,
  emissionType: EmissionType.NORMAL,
};

describePostgres('PgCompanyConfigRepository', () => {
  const pool = usePostgres();
  const configs = () => new PgCompanyConfigRepository(pool());

  it('has no config until it is saved, then reads it back and updates it', async () => {
    expect(await configs().find()).toBeNull();

    await configs().save(makeConfig({ signingCertId: null, specialTaxpayerResolution: '123' }));
    await configs().save(makeConfig({ signingCertId: null, name: 'ACME CIA. LTDA.' }));

    const config = (await configs().find())!;
    expect(config).toMatchObject({
      id: 'default',
      taxId: '1792141001001',
      name: 'ACME CIA. LTDA.',
      branchCode: '001',
      salePointCode: '001',
      specialTaxpayerResolution: null,
      accountingRequired: false,
      environment: Environment.PRODUCTION,
      emissionType: EmissionType.NORMAL,
      signingCertId: null,
    });
  });

  it('gives a new issuer the sequence 1, and saving the config does not move it', async () => {
    await configs().save(makeConfig({ signingCertId: null }));
    expect((await configs().find())!.invoiceSequence).toBe(1);

    expect(await configs().nextInvoiceSequence()).toBe(1);
    // The entity carries a sequence, but saving the profile leaves the counter alone
    await configs().save(makeConfig({ signingCertId: null, invoiceSequence: 1 }));

    expect(await configs().nextInvoiceSequence()).toBe(2);
    expect((await configs().find())!.invoiceSequence).toBe(3);
  });

  it('hands out consecutive numbers to concurrent callers, without repeating any', async () => {
    const numbers = await Promise.all(
      Array.from({ length: 20 }, () => configs().nextInvoiceSequence()),
    );

    expect([...numbers].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('only moves the sequence when the saved config brings invoiceSequence', async () => {
    const certificates = new PgCertificateRepository(pool());
    const save = new SaveCompanyConfigCommand(configs(), certificates, {
      issuerChanged: vi.fn(),
    });

    expect((await save.execute(CONFIG_INPUT)).invoiceSequence).toBe(1);
    expect(await configs().nextInvoiceSequence()).toBe(1);
    expect((await save.execute(CONFIG_INPUT)).invoiceSequence).toBe(2);

    expect((await save.execute({ ...CONFIG_INPUT, invoiceSequence: 500 })).invoiceSequence).toBe(
      500,
    );
    expect(await configs().nextInvoiceSequence()).toBe(500);
  });
});

describePostgres('PgCertificateRepository', () => {
  const pool = usePostgres();
  const certificates = () => new PgCertificateRepository(pool());

  it('saves, finds, lists (latest first) and deletes certificates', async () => {
    const older = makeCertificate({ id: randomUUID() });
    const newer = new Certificate(
      randomUUID(),
      '456',
      'CN=ACME 2',
      'CN=CA',
      new Date('2026-01-01T00:00:00Z'),
      new Date('2027-01-01T00:00:00Z'),
      'acme-2.p12',
      'v1:p12-2',
      new Date('2026-01-01T00:00:00Z'),
      'v1:secret-2',
    );
    await certificates().save(older);
    await certificates().save(newer);

    expect(await certificates().findById(older.id)).toEqual(older);
    expect(await certificates().findById('cert-1')).toBeNull();
    expect((await certificates().findAll()).map((cert) => cert.id)).toEqual([newer.id, older.id]);
    expect((await certificates().findBySerialNumber('456'))?.id).toBe(newer.id);
    expect(await certificates().findBySerialNumber('999')).toBeNull();

    await certificates().delete(older.id);
    expect(await certificates().findById(older.id)).toBeNull();
  });

  it("can't delete the certificate the config selects", async () => {
    const certificate = makeCertificate({ id: randomUUID() });
    await certificates().save(certificate);
    await new PgCompanyConfigRepository(pool()).save(makeConfig({ signingCertId: certificate.id }));

    await expect(certificates().delete(certificate.id)).rejects.toThrow(/foreign key/);
  });

  it('keeps the uploaded .p12 and its password encrypted, ready to sign with', async () => {
    const cipher = new AesGcmSecretCipher(randomBytes(32).toString('base64'));
    const p12 = randomBytes(1024);
    const parser: P12ParserPort = {
      parse: vi.fn(() => ({
        serialNumber: '789',
        subject: 'CN=ACME',
        issuer: 'CN=CA',
        validFrom: new Date('2026-01-01T00:00:00Z'),
        validTo: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      })),
    };
    const upload = new UploadCertificateCommand(parser, certificates(), cipher, {
      issuerChanged: vi.fn(),
    });

    const uploaded = await upload.execute({
      fileBuffer: p12,
      fileName: 'acme.p12',
      password: 'clave',
    });

    const { rows } = await pool().query(
      'SELECT p12_ciphertext, password_ciphertext FROM certificates WHERE id = $1',
      [uploaded.id],
    );
    expect(rows[0].p12_ciphertext).toMatch(/^v1:/);
    expect(rows[0].password_ciphertext).toMatch(/^v1:/);
    expect(rows[0].password_ciphertext).not.toContain('clave');

    const stored = (await certificates().findById(uploaded.id))!;
    const key = await new CertificateKeyLoader(cipher).load(stored);
    expect(key.p12.equals(p12)).toBe(true);
    expect(key.password).toBe('clave');
  });
});
