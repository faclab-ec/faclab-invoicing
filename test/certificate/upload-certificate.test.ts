import { describe, expect, it, vi } from 'vitest';

import {
  DeleteCertificateCommand,
  UploadCertificateCommand,
} from '#/modules/certificate/app/certificate.commands';
import { P12ParserPort } from '#/modules/certificate/domain/ports';
import { SaveCompanyConfigCommand } from '#/modules/company-config/app/company-config.commands';
import { EmissionType, Environment } from '#/modules/company-config/domain/company-config';
import { AesGcmSecretCipher } from '#/shared/infra/secret-cipher';

import {
  InMemoryCertificateRepository,
  InMemoryCompanyConfigRepository,
  makeCertificate,
  makeConfig,
  RUC_A,
  RUC_B,
  TENANT_A,
  TENANT_B,
} from '../helpers';

const YEAR = 365 * 24 * 60 * 60 * 1000;
const cipher = new AesGcmSecretCipher(Buffer.alloc(32, 7).toString('base64'));

function setup(taxIds: string[]) {
  const configs = new InMemoryCompanyConfigRepository();
  const certificates = new InMemoryCertificateRepository();
  const listener = { issuerChanged: vi.fn() };
  const parser: P12ParserPort = {
    parse: vi.fn(() => ({
      serialNumber: '789',
      subject: 'CN=JUAN PEREZ',
      issuer: 'CN=CA',
      taxIds,
      validFrom: new Date('2026-01-01T00:00:00Z'),
      validTo: new Date(Date.now() + YEAR),
    })),
  };
  const upload = new UploadCertificateCommand(parser, certificates, configs, cipher, listener);
  const input = { fileBuffer: Buffer.from('p12'), fileName: 'firma.p12', password: 'clave' };
  return { configs, certificates, listener, upload, input };
}

describe('UploadCertificateCommand', () => {
  it("keeps a certificate of the issuer's RUC for its company", async () => {
    const { configs, certificates, listener, upload, input } = setup([RUC_A]);
    await configs.save(makeConfig({ signingCertId: null }));

    const certificate = await upload.execute(TENANT_A, input);

    expect(certificate.tenantId).toBe(TENANT_A);
    expect(certificate.taxIds).toEqual([RUC_A]);
    expect(await certificates.findAll(TENANT_A)).toHaveLength(1);
    expect(listener.issuerChanged).toHaveBeenCalledWith(TENANT_A);
  });

  it("accepts a natural person's certificate that only names the cédula", async () => {
    const { configs, upload, input } = setup(['1710034065']);
    await configs.save(makeConfig({ taxId: '1710034065001', signingCertId: null }));

    await expect(upload.execute(TENANT_A, input)).resolves.toMatchObject({
      taxIds: ['1710034065'],
    });
  });

  it('rejects a certificate of another RUC with a clear error', async () => {
    const { configs, certificates, upload, input } = setup([RUC_B]);
    await configs.save(makeConfig({ signingCertId: null }));

    const result = upload.execute(TENANT_A, input);

    await expect(result).rejects.toMatchObject({
      statusCode: 422,
      code: 'CERTIFICATE_RUC_MISMATCH',
      message: `The certificate belongs to ${RUC_B}, not to the issuer's RUC ${RUC_A}`,
    });
    expect(certificates.certificates.size).toBe(0);
  });

  it('rejects a certificate that names no RUC nor cédula', async () => {
    const { configs, upload, input } = setup([]);
    await configs.save(makeConfig({ signingCertId: null }));

    await expect(upload.execute(TENANT_A, input)).rejects.toMatchObject({
      statusCode: 422,
      code: 'CERTIFICATE_RUC_UNKNOWN',
    });
  });

  it('asks for the fiscal profile first: without it there is no RUC to check', async () => {
    const { upload, input } = setup([RUC_A]);

    await expect(upload.execute(TENANT_A, input)).rejects.toMatchObject({
      statusCode: 409,
      code: 'ISSUER_NOT_CONFIGURED',
    });
  });
});

describe('SaveCompanyConfigCommand', () => {
  const input = {
    taxId: RUC_A,
    name: 'ACME S.A.',
    tradeName: 'ACME',
    mainAddress: 'Quito',
    environment: Environment.TESTING,
    emissionType: EmissionType.NORMAL,
  };

  function save() {
    const configs = new InMemoryCompanyConfigRepository();
    const certificates = new InMemoryCertificateRepository();
    const command = new SaveCompanyConfigCommand(configs, certificates, { issuerChanged: vi.fn() });
    return { configs, certificates, command };
  }

  it('selects a certificate of the company and its RUC', async () => {
    const { certificates, command } = save();
    await certificates.save(makeCertificate({ id: 'cert-a' }));

    const config = await command.execute(TENANT_A, { ...input, signingCertId: 'cert-a' });

    expect(config).toMatchObject({ tenantId: TENANT_A, signingCertId: 'cert-a' });
  });

  it("can't select another company's certificate", async () => {
    const { certificates, command } = save();
    await certificates.save(makeCertificate({ id: 'cert-b', tenantId: TENANT_B, taxIds: [RUC_B] }));

    await expect(
      command.execute(TENANT_A, { ...input, signingCertId: 'cert-b' }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'VALIDATION_ERROR' });
  });

  it("can't keep a certificate when the RUC changes to another taxpayer's", async () => {
    const { certificates, command } = save();
    await certificates.save(makeCertificate({ id: 'cert-a' }));

    await expect(
      command.execute(TENANT_A, { ...input, taxId: RUC_B, signingCertId: 'cert-a' }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'CERTIFICATE_RUC_MISMATCH' });
  });
});

describe('DeleteCertificateCommand', () => {
  it("doesn't find another company's certificate", async () => {
    const certificates = new InMemoryCertificateRepository();
    await certificates.save(makeCertificate({ id: 'cert-b', tenantId: TENANT_B }));
    const command = new DeleteCertificateCommand(
      certificates,
      new InMemoryCompanyConfigRepository(),
      { issuerChanged: vi.fn() },
    );

    await expect(command.execute(TENANT_A, 'cert-b')).rejects.toMatchObject({ statusCode: 404 });
    expect(await certificates.findById(TENANT_B, 'cert-b')).not.toBeNull();
  });
});
