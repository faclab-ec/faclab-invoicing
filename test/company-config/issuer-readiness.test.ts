import { describe, expect, it, vi } from 'vitest';

import { CertificateKeyLoader } from '#/modules/certificate/app/certificate-key-loader';
import { Certificate } from '#/modules/certificate/domain/certificate';
import { P12ParserPort } from '#/modules/certificate/domain/ports';
import { CertificateRepository } from '#/modules/certificate/domain/repository';
import { IssuerReadinessService } from '#/modules/company-config/app/issuer-readiness';
import { CompanyConfig, Environment } from '#/modules/company-config/domain/company-config';
import { IssuerNotReadyError } from '#/modules/company-config/domain/readiness';

import { makeCertificate, makeConfig } from '../helpers';

const DAY = 24 * 60 * 60 * 1000;

function service(options: {
  config: CompanyConfig | null;
  certificate?: Certificate | null;
  unreadable?: boolean;
}) {
  const configRepo = {
    save: vi.fn(),
    find: vi.fn(async () => options.config),
    nextInvoiceSequence: vi.fn(),
  };
  const certRepo = {
    findById: vi.fn(async () => options.certificate ?? null),
  } as unknown as CertificateRepository;
  const keyLoader = {
    load: vi.fn(async () => {
      if (options.unreadable) throw new Error('Invalid password?');
      return { p12: Buffer.from('p12'), password: 'secret' };
    }),
  } as unknown as CertificateKeyLoader;
  const parser: P12ParserPort = { parse: vi.fn() };
  return {
    readiness: new IssuerReadinessService(configRepo, certRepo, keyLoader, parser),
    configRepo,
  };
}

const codes = async (readiness: IssuerReadinessService) =>
  (await readiness.check()).issues.map((issue) => issue.code);

describe('IssuerReadinessService', () => {
  it('is ready with a valid config and a usable certificate', async () => {
    const { readiness } = service({ config: makeConfig(), certificate: makeCertificate() });

    const report = await readiness.check();

    expect(report.ready).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.certificate?.id).toBe('cert-1');
    await expect(readiness.requireReady()).resolves.toMatchObject({
      certificate: { id: 'cert-1' },
    });
  });

  it('reports a missing config and refuses to give an issuer', async () => {
    const { readiness } = service({ config: null });

    expect(await codes(readiness)).toEqual(['CONFIG_MISSING']);
    await expect(readiness.requireReady()).rejects.toBeInstanceOf(IssuerNotReadyError);
  });

  it('flags config fields the SRI would reject', async () => {
    const { readiness } = service({
      config: makeConfig({ branchCode: '1', salePointCode: '0001' }),
      certificate: makeCertificate(),
    });

    const report = await readiness.check();

    expect(report.ready).toBe(false);
    expect(report.issues[0]).toMatchObject({ code: 'CONFIG_INVALID', severity: 'error' });
    expect(report.issues[0].message).toContain('branchCode, salePointCode');
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

    const report = await readiness.check();

    expect(report.ready).toBe(true);
    expect(report.issues.map((i) => [i.code, i.severity])).toEqual([
      ['TEST_ENVIRONMENT', 'warning'],
      ['CERTIFICATE_EXPIRING_SOON', 'warning'],
    ]);
  });

  it('caches the answer until invalidated', async () => {
    const { readiness, configRepo } = service({ config: null });

    await readiness.check();
    await readiness.check();
    expect(configRepo.find).toHaveBeenCalledTimes(1);

    readiness.invalidate();
    await readiness.check();
    expect(configRepo.find).toHaveBeenCalledTimes(2);
  });
});
