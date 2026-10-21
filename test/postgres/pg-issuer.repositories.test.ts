import { randomBytes, randomUUID } from 'crypto';
import { expect, it, vi } from 'vitest';

import { UploadCertificateCommand } from '#/modules/certificate/app/certificate.commands';
import { CertificateKeyLoader } from '#/modules/certificate/app/certificate-key-loader';
import { P12ParserPort } from '#/modules/certificate/domain/ports';
import { PgCertificateRepository } from '#/modules/certificate/infra/persistence/pg-certificate.repository';
import { SaveCompanyConfigCommand } from '#/modules/company-config/app/company-config.commands';
import { SetNextSequenceCommand } from '#/modules/company-config/app/sequence.commands';
import {
  EmissionType,
  Environment,
  RimpeRegime,
} from '#/modules/company-config/domain/company-config';
import { INVOICE_DOC_TYPE, SequenceKey } from '#/modules/company-config/domain/sequence';
import { PgCompanyConfigRepository } from '#/modules/company-config/infra/persistence/pg-company-config.repository';
import { PgSequenceRepository } from '#/modules/company-config/infra/persistence/pg-sequence.repository';
import { Invoice } from '#/modules/invoice/domain/invoice';
import { PgInvoiceRepository } from '#/modules/invoice/infra/persistence/pg-invoice.repository';
import { ConflictError } from '#/shared/errors/app-error';
import { AesGcmSecretCipher } from '#/shared/infra/secret-cipher';

import {
  makeCertificate,
  makeConfig,
  makePoint,
  makeSale,
  RUC_A,
  RUC_B,
  TENANT_A,
  TENANT_B,
} from '../helpers';
import { describePostgres, usePostgres } from './support';

const CONFIG_INPUT = {
  taxId: RUC_A,
  name: 'ACME S.A.',
  tradeName: 'ACME',
  mainAddress: 'Quito',
  environment: Environment.TESTING,
  emissionType: EmissionType.NORMAL,
};

const keyOf = (tenantId: string, establishment = '001', emissionPoint = '001'): SequenceKey => ({
  tenantId,
  establishment,
  emissionPoint,
  docType: INVOICE_DOC_TYPE,
});

describePostgres('PgCompanyConfigRepository', () => {
  const pool = usePostgres();
  const configs = () => new PgCompanyConfigRepository(pool());

  it('keeps one fiscal profile per company, read back and updated on its own', async () => {
    expect(await configs().find(TENANT_A)).toBeNull();

    await configs().save(makeConfig({ signingCertId: null, specialTaxpayerResolution: '123' }));
    await configs().save(
      makeConfig({
        tenantId: TENANT_B,
        taxId: RUC_B,
        signingCertId: null,
        rimpeRegime: RimpeRegime.ENTREPRENEUR,
      }),
    );
    await configs().save(makeConfig({ signingCertId: null, name: 'ACME CIA. LTDA.' }));

    expect(await configs().find(TENANT_A)).toMatchObject({
      tenantId: TENANT_A,
      taxId: RUC_A,
      name: 'ACME CIA. LTDA.',
      specialTaxpayerResolution: null,
      rimpeRegime: null,
      accountingRequired: false,
      environment: Environment.PRODUCTION,
      emissionType: EmissionType.NORMAL,
      signingCertId: null,
    });
    expect(await configs().find(TENANT_B)).toMatchObject({
      tenantId: TENANT_B,
      taxId: RUC_B,
      rimpeRegime: RimpeRegime.ENTREPRENEUR,
    });
  });

  it('never moves a sequence when the profile is saved, even with the old invoiceSequence', async () => {
    const sequences = new PgSequenceRepository(pool());
    const save = new SaveCompanyConfigCommand(configs(), new PgCertificateRepository(pool()), {
      issuerChanged: vi.fn(),
    });
    await sequences.setNext(keyOf(TENANT_A), 500);

    await save.execute(TENANT_A, CONFIG_INPUT);
    // What faclab-web sends until S2.9: fields the profile no longer has
    await save.execute(TENANT_A, {
      ...CONFIG_INPUT,
      invoiceSequence: 1,
      branchCode: '001',
      salePointCode: '001',
      branchAddress: 'Quito',
    } as typeof CONFIG_INPUT);

    expect(await sequences.find(keyOf(TENANT_A))).toMatchObject({ lastValue: 499 });
    expect(await sequences.findAll(TENANT_A)).toHaveLength(1);
  });
});

describePostgres('PgSequenceRepository', () => {
  const pool = usePostgres();
  const sequences = () => new PgSequenceRepository(pool());

  it('sets where the numbering of an emission point continues, never backwards', async () => {
    const setNext = new SetNextSequenceCommand(sequences());

    expect(
      await setNext.execute(TENANT_A, {
        establishment: '001',
        emissionPoint: '002',
        nextSequence: 500,
      }),
    ).toMatchObject({ establishment: '001', emissionPoint: '002', lastValue: 499 });
    // The same value again is fine; a lower one is not
    await setNext.execute(TENANT_A, {
      establishment: '001',
      emissionPoint: '002',
      nextSequence: 500,
    });
    const back = setNext.execute(TENANT_A, {
      establishment: '001',
      emissionPoint: '002',
      nextSequence: 100,
    });

    await expect(back).rejects.toBeInstanceOf(ConflictError);
    await expect(back).rejects.toMatchObject({ code: 'SEQUENCE_CANNOT_GO_BACK' });
    expect(await sequences().find(keyOf(TENANT_A, '001', '002'))).toMatchObject({ lastValue: 499 });
  });

  it("can't go back below a number an invoice already took", async () => {
    const invoices = new PgInvoiceRepository(pool());
    await sequences().setNext(keyOf(TENANT_A), 41);
    const invoice = Invoice.receive(randomUUID(), makePoint(), makeSale());
    await invoices.createInvoice(invoice);
    await invoices.assignSequence(invoice);

    expect(invoice.sequence).toBe('000000041');
    expect(await sequences().setNext(keyOf(TENANT_A), 41)).toBeNull();
    expect(await sequences().setNext(keyOf(TENANT_A), 42)).toMatchObject({ lastValue: 41 });
  });

  it("lists only the company's counters", async () => {
    await sequences().setNext(keyOf(TENANT_A, '002', '001'), 10);
    await sequences().setNext(keyOf(TENANT_A), 5);
    await sequences().setNext(keyOf(TENANT_B), 900);

    expect(
      (await sequences().findAll(TENANT_A)).map((s) => [
        s.establishment,
        s.emissionPoint,
        s.lastValue,
      ]),
    ).toEqual([
      ['001', '001', 4],
      ['002', '001', 9],
    ]);
  });
});

describePostgres('PgCertificateRepository', () => {
  const pool = usePostgres();
  const certificates = () => new PgCertificateRepository(pool());

  it("saves, finds, lists (latest first) and deletes a company's certificates", async () => {
    const older = makeCertificate({ id: randomUUID() });
    const newer = makeCertificate({ id: randomUUID(), taxIds: ['1712345675', RUC_A] });
    await certificates().save(older);
    await certificates().save(newer);

    expect(await certificates().findById(TENANT_A, older.id)).toEqual(older);
    expect((await certificates().findById(TENANT_A, newer.id))?.taxIds).toEqual([
      '1712345675',
      RUC_A,
    ]);
    expect(await certificates().findById(TENANT_A, 'cert-1')).toBeNull();
    await pool().query("UPDATE certificates SET uploaded_at = '2024-01-01' WHERE id = $1", [
      older.id,
    ]);
    expect((await certificates().findAll(TENANT_A)).map((cert) => cert.id)).toEqual([
      newer.id,
      older.id,
    ]);

    await certificates().delete(TENANT_A, older.id);
    expect(await certificates().findById(TENANT_A, older.id)).toBeNull();
  });

  it("never shows nor deletes another company's certificate", async () => {
    const ofB = makeCertificate({ id: randomUUID(), tenantId: TENANT_B, taxIds: [RUC_B] });
    await certificates().save(ofB);

    expect(await certificates().findById(TENANT_A, ofB.id)).toBeNull();
    expect(await certificates().findAll(TENANT_A)).toEqual([]);
    await certificates().delete(TENANT_A, ofB.id);

    expect(await certificates().findById(TENANT_B, ofB.id)).toEqual(ofB);
  });

  it("can't delete the certificate the config selects", async () => {
    const certificate = makeCertificate({ id: randomUUID() });
    await certificates().save(certificate);
    await new PgCompanyConfigRepository(pool()).save(makeConfig({ signingCertId: certificate.id }));

    await expect(certificates().delete(TENANT_A, certificate.id)).rejects.toThrow(/foreign key/);
  });

  it("can't select another company's certificate", async () => {
    const ofA = makeCertificate({ id: randomUUID() });
    await certificates().save(ofA);

    const save = new PgCompanyConfigRepository(pool()).save(
      makeConfig({ tenantId: TENANT_B, taxId: RUC_B, signingCertId: ofA.id }),
    );

    await expect(save).rejects.toThrow(/fk_issuers_signing_cert_tenant/);
  });

  it('keeps the uploaded .p12 and its password encrypted, ready to sign with', async () => {
    const cipher = new AesGcmSecretCipher(randomBytes(32).toString('base64'));
    const configs = new PgCompanyConfigRepository(pool());
    await configs.save(makeConfig({ signingCertId: null }));
    const p12 = randomBytes(1024);
    const parser: P12ParserPort = {
      parse: vi.fn(() => ({
        serialNumber: '789',
        subject: 'CN=ACME',
        issuer: 'CN=CA',
        taxIds: [RUC_A],
        validFrom: new Date('2026-01-01T00:00:00Z'),
        validTo: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      })),
    };
    const upload = new UploadCertificateCommand(parser, certificates(), configs, cipher, {
      issuerChanged: vi.fn(),
    });

    const uploaded = await upload.execute(TENANT_A, {
      fileBuffer: p12,
      fileName: 'acme.p12',
      password: 'clave',
    });

    const { rows } = await pool().query(
      'SELECT tenant_id, p12_ciphertext, password_ciphertext FROM certificates WHERE id = $1',
      [uploaded.id],
    );
    expect(rows[0].tenant_id).toBe(TENANT_A);
    expect(rows[0].p12_ciphertext).toMatch(/^v1:/);
    expect(rows[0].password_ciphertext).toMatch(/^v1:/);
    expect(rows[0].password_ciphertext).not.toContain('clave');

    const stored = (await certificates().findById(TENANT_A, uploaded.id))!;
    const key = await new CertificateKeyLoader(cipher).load(stored);
    expect(key.p12.equals(p12)).toBe(true);
    expect(key.password).toBe('clave');
  });
});
