import { describe, expect, it, vi } from 'vitest';

import { CertificateKeyLoader } from '#/modules/certificate/app/certificate-key-loader';
import { Certificate } from '#/modules/certificate/domain/certificate';
import { P12ParserPort } from '#/modules/certificate/domain/ports';
import { CertificateRepository } from '#/modules/certificate/domain/repository';
import { IssuerReadinessService } from '#/modules/company-config/app/issuer-readiness';
import { CompanyConfig, Environment } from '#/modules/company-config/domain/company-config';
import { IssuerNotReadyError } from '#/modules/company-config/domain/readiness';

import { makeCertificate, makeConfig, RUC_B, TENANT_A, TENANT_B } from '../helpers';

const DAY = 24 * 60 * 60 * 1000;

function service(options: {
  config: CompanyConfig | null;
  certificate?: Certificate | null;
  unreadable?: boolean;
  productionAllowed?: boolean;
}) {
  // Company A's config and certificate; company B has neither
  const configRepo = {
    save: vi.fn(),
    find: vi.fn(async (tenantId: string) => (tenantId === TENANT_A ? options.config : null)),
  };
  const certRepo = {
    findById: vi.fn(async (tenantId: string) =>
      tenantId === TENANT_A ? (options.certificate ?? null) : null,
    ),
  } as unknown as CertificateRepository;
  const keyLoader = {
    load: vi.fn(async () => {
      if (options.unreadable) throw new Error('Invalid password?');
      return { p12: Buffer.from('p12'), password: 'secret' };
    }),
  } as unknown as CertificateKeyLoader;
  const parser: P12ParserPort = { parse: vi.fn() };
  return {
    readiness: new IssuerReadinessService(configRepo, certRepo, keyLoader, parser, {
      productionAllowed: options.productionAllowed,
    }),
    configRepo,
  };
}

const codes = async (readiness: IssuerReadinessService) =>
  (await readiness.check(TENANT_A)).issues.map((issue) => issue.code);

describe('IssuerReadinessService', () => {
  it('is ready with a valid config and a usable certificate', async () => {
    const { readiness } = service({ config: makeConfig(), certificate: makeCertificate() });

    const report = await readiness.check(TENANT_A);

    expect(report.ready).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.certificate?.id).toBe('cert-1');
    await expect(readiness.requireReady(TENANT_A)).resolves.toMatchObject({
      certificate: { id: 'cert-1' },
    });
  });

  it('reports a missing config and refuses to give an issuer', async () => {
    const { readiness } = service({ config: null });

    expect(await codes(readiness)).toEqual(['CONFIG_MISSING']);
    await expect(readiness.requireReady(TENANT_A)).rejects.toBeInstanceOf(IssuerNotReadyError);
  });

  it('flags resolution numbers the invoice XML would not take', async () => {
    const { readiness } = service({
      config: makeConfig({
        specialTaxpayerResolution: 'NAC-2024-01',
        withholdingAgentResolution: '00000001',
      }),
      certificate: makeCertificate(),
    });

    const report = await readiness.check(TENANT_A);

    expect(report.ready).toBe(false);
    expect(report.issues[0].code).toBe('CONFIG_INVALID');
    expect(report.issues[0].message).toContain(
      'specialTaxpayerResolution, withholdingAgentResolution',
    );
  });

  it('takes resolution numbers as the XML writes them', async () => {
    const { readiness } = service({
      config: makeConfig({ specialTaxpayerResolution: '5368', withholdingAgentResolution: '1' }),
      certificate: makeCertificate(),
    });

    expect((await readiness.check(TENANT_A)).ready).toBe(true);
  });

  it('flags config fields the SRI would reject', async () => {
    const { readiness } = service({
      config: makeConfig({ taxId: '179214100' }),
      certificate: makeCertificate({ taxIds: ['179214100'] }),
    });

    const report = await readiness.check(TENANT_A);

    expect(report.ready).toBe(false);
    expect(report.issues[0]).toMatchObject({ code: 'CONFIG_INVALID', severity: 'error' });
    expect(report.issues[0].message).toContain('taxId');
  });

  it('refuses the production environment where only the test one is reachable', async () => {
    const { readiness } = service({
      config: makeConfig(),
      certificate: makeCertificate(),
      productionAllowed: false,
    });

    expect(await codes(readiness)).toEqual(['ENVIRONMENT_NOT_ALLOWED']);
  });

  it('flags a selected certificate of another RUC', async () => {
    const { readiness } = service({
      config: makeConfig(),
      certificate: makeCertificate({ taxIds: [RUC_B] }),
    });

    expect(await codes(readiness)).toEqual(['CERTIFICATE_RUC_MISMATCH']);
  });

  it("answers for each company: one that can't invoice doesn't block another", async () => {
    const { readiness } = service({ config: makeConfig(), certificate: makeCertificate() });

    expect((await readiness.check(TENANT_A)).ready).toBe(true);
    expect((await readiness.check(TENANT_B)).issues.map((issue) => issue.code)).toEqual([
      'CONFIG_MISSING',
    ]);
    await expect(readiness.requireReady(TENANT_B)).rejects.toBeInstanceOf(IssuerNotReadyError);
  });

  it('checks the selected certificate', async () => {
    expect(await codes(service({ config: makeConfig({ signingCertId: null }) }).readiness)).toEqual(
      ['CERTIFICATE_NOT_SELECTED'],
    );
    expect(await codes(service({ config: makeConfig(), certificate: null }).readiness)).toEqual([
      'CERTIFICATE_NOT_FOUND',
    ]);
    const expired = makeCertificate({ validTo: new Date(Date.now() - DAY) });
    expect(await codes(service({ config: makeConfig(), certificate: expired }).readiness)).toEqual([
      'CERTIFICATE_EXPIRED',
    ]);
    expect(
      await codes(
        service({ config: makeConfig(), certificate: makeCertificate(), unreadable: true })
          .readiness,
      ),
    ).toEqual(['CERTIFICATE_UNREADABLE']);
  });

  it('warns about a certificate close to expiring and the test environment, but stays ready', async () => {
    const { readiness } = service({
      config: makeConfig({ environment: Environment.TESTING }),
      certificate: makeCertificate({ validTo: new Date(Date.now() + 10 * DAY) }),
    });

    const report = await readiness.check(TENANT_A);

    expect(report.ready).toBe(true);
    expect(report.issues.map((i) => [i.code, i.severity])).toEqual([
      ['TEST_ENVIRONMENT', 'warning'],
      ['CERTIFICATE_EXPIRING_SOON', 'warning'],
    ]);
  });

  it("caches each company's answer until it is invalidated", async () => {
    const { readiness, configRepo } = service({ config: null });

    await readiness.check(TENANT_A);
    await readiness.check(TENANT_A);
    await readiness.check(TENANT_B);
    expect(configRepo.find).toHaveBeenCalledTimes(2);

    // Only B's answer is forgotten
    readiness.invalidate(TENANT_B);
    await readiness.check(TENANT_A);
    await readiness.check(TENANT_B);
    expect(configRepo.find).toHaveBeenCalledTimes(3);

    // Every company's
    readiness.invalidate();
    await readiness.check(TENANT_A);
    await readiness.check(TENANT_B);
    expect(configRepo.find).toHaveBeenCalledTimes(5);
  });
});
