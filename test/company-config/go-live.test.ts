import { describe, expect, it, vi } from 'vitest';

import { SaveCompanyConfigCommand } from '#/modules/company-config/app/company-config.commands';
import { GetCompanyConfigQuery } from '#/modules/company-config/app/company-config.commands';
import { GoLiveCommand } from '#/modules/company-config/app/go-live.command';
import {
  DeleteIssuerLogoCommand,
  GetIssuerLogoQuery,
  SetIssuerLogoCommand,
} from '#/modules/company-config/app/issuer-logo.commands';
import { ReadyIssuer } from '#/modules/company-config/app/issuer-readiness';
import {
  ListSequencesQuery,
  SetNextSequenceCommand,
} from '#/modules/company-config/app/sequence.commands';
import { Environment } from '#/modules/company-config/domain/company-config';
import { IssuerProductionRepository } from '#/modules/company-config/domain/production';
import { registerCompanyConfigRoutes } from '#/modules/company-config/infra/http/company-config.routes';
import { SubmitTestInvoiceCommand } from '#/modules/invoice/app/commands/onboarding-test-invoice';
import { ReceiveSaleCommand } from '#/modules/invoice/app/commands/receive-sale';
import { InvoiceProcessor } from '#/modules/invoice/app/services/invoice-processor';
import { createHttpServer } from '#/shared/infra/http-server';

import {
  authorizeAs,
  InMemoryCertificateRepository,
  InMemoryCompanyConfigRepository,
  InMemoryDocumentStorage,
  InMemoryInvoiceRepository,
  InMemorySequenceRepository,
  invoiceSteps,
  makeCertificate,
  makeConfig,
  readinessStub,
  RUC_A,
  TENANT_A,
} from '../helpers';

const READY: ReadyIssuer = {
  config: makeConfig({ environment: Environment.TESTING }),
  certificate: makeCertificate(),
};

async function setup({ productionAllowed = true, testInvoice = 'authorized' } = {}) {
  const configs = new InMemoryCompanyConfigRepository();
  await configs.save(makeConfig({ environment: Environment.TESTING }));
  const invoices = new InMemoryInvoiceRepository();
  const readiness = readinessStub(READY);
  const production: IssuerProductionRepository = {
    enterProduction: vi.fn(async (tenantId) => {
      const config = await configs.find(tenantId);
      await configs.save(makeConfig({ environment: Environment.PRODUCTION }));
      return config ? { removedTestInvoices: 1, restoredSequences: 1 } : null;
    }),
  };
  const listener = { issuerChanged: vi.fn() };
  const goLive = new GoLiveCommand(
    configs,
    readiness,
    invoices,
    production,
    listener,
    productionAllowed,
  );
  if (testInvoice !== 'none') {
    const submit = new SubmitTestInvoiceCommand(
      configs,
      readiness,
      new ReceiveSaleCommand(invoices),
      invoices,
    );
    const invoice = await submit.execute(TENANT_A);
    if (testInvoice === 'authorized') {
      await new InvoiceProcessor(
        invoices,
        invoices,
        invoiceSteps(invoices, readiness),
        readiness,
        null,
      ).run(invoice.id);
    }
  }
  return { configs, invoices, readiness, production, listener, goLive };
}

const CONFIRM = { confirmRuc: RUC_A, acknowledge: true };
const ACTOR = { id: '7', username: 'ana' };

describe('going to production (S8.5)', () => {
  it('moves the company with its RUC typed again and an authorized test invoice, audited with who did it', async () => {
    const { goLive, production, listener } = await setup();

    const config = await goLive.execute(TENANT_A, CONFIRM, ACTOR);

    expect(config.environment).toBe(Environment.PRODUCTION);
    expect(production.enterProduction).toHaveBeenCalledWith(TENANT_A, ACTOR);
    expect(listener.issuerChanged).toHaveBeenCalledWith(TENANT_A);
  });

  it.each([
    ['another RUC', { confirmRuc: '1790000000001', acknowledge: true }, 'CONFIRMATION_MISMATCH'],
    ['no acknowledgement', { confirmRuc: RUC_A, acknowledge: false }, 'CONFIRMATION_MISMATCH'],
  ])('refuses %s', async (_name, input, code) => {
    const { goLive, production } = await setup();

    await expect(goLive.execute(TENANT_A, input, ACTOR)).rejects.toMatchObject({ code });
    expect(production.enterProduction).not.toHaveBeenCalled();
  });

  it('refuses without an authorized test invoice', async () => {
    for (const testInvoice of ['none', 'pending']) {
      const { goLive, production } = await setup({ testInvoice });

      await expect(goLive.execute(TENANT_A, CONFIRM, ACTOR)).rejects.toMatchObject({
        code: 'TEST_INVOICE_REQUIRED',
      });
      expect(production.enterProduction).not.toHaveBeenCalled();
    }
  });

  it('refuses in a deployment that only reaches the test environment', async () => {
    const { goLive } = await setup({ productionAllowed: false });

    await expect(goLive.execute(TENANT_A, CONFIRM, ACTOR)).rejects.toMatchObject({
      code: 'ENVIRONMENT_NOT_ALLOWED',
    });
  });

  it('refuses a company without profile or already in production', async () => {
    const { goLive, configs } = await setup();
    await goLive.execute(TENANT_A, CONFIRM, ACTOR);

    await expect(goLive.execute(TENANT_A, CONFIRM, ACTOR)).rejects.toMatchObject({
      code: 'ALREADY_IN_PRODUCTION',
    });
    configs.configs.clear();
    await expect(goLive.execute(TENANT_A, CONFIRM, ACTOR)).rejects.toMatchObject({
      code: 'ISSUER_NOT_CONFIGURED',
    });
  });

  it('is the only way: saving the profile with the production environment is refused', async () => {
    const configs = new InMemoryCompanyConfigRepository();
    const save = new SaveCompanyConfigCommand(configs, new InMemoryCertificateRepository(), {
      issuerChanged: vi.fn(),
    });
    const input = {
      taxId: RUC_A,
      name: 'ACME S.A.',
      tradeName: 'ACME',
      mainAddress: 'Quito',
      environment: Environment.PRODUCTION,
      emissionType: 1,
    };

    // Neither as a first profile nor from the test environment
    await expect(save.execute(TENANT_A, input)).rejects.toMatchObject({ code: 'USE_GO_LIVE' });
    await save.execute(TENANT_A, { ...input, environment: Environment.TESTING });
    await expect(save.execute(TENANT_A, input)).rejects.toMatchObject({ code: 'USE_GO_LIVE' });
  });

  it('keeps a company that is already in production saving its profile', async () => {
    const configs = new InMemoryCompanyConfigRepository();
    await configs.save(makeConfig({ environment: Environment.PRODUCTION }));
    const save = new SaveCompanyConfigCommand(configs, new InMemoryCertificateRepository(), {
      issuerChanged: vi.fn(),
    });

    const saved = await save.execute(TENANT_A, {
      taxId: RUC_A,
      name: 'ACME S.A.',
      tradeName: 'ACME 2',
      mainAddress: 'Quito',
      environment: Environment.PRODUCTION,
      emissionType: 1,
    });

    expect(saved.environment).toBe(Environment.PRODUCTION);
  });

  it('over HTTP', async () => {
    const { configs, goLive } = await setup();
    const app = await createHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: [],
      serviceName: 'faclab-invoicing',
      serviceVersion: 'test',
    });
    const sequences = new InMemorySequenceRepository();
    const storage = new InMemoryDocumentStorage();
    registerCompanyConfigRoutes(
      app,
      {
        save: new SaveCompanyConfigCommand(configs, new InMemoryCertificateRepository(), {
          issuerChanged: vi.fn(),
        }),
        get: new GetCompanyConfigQuery(configs),
        listSequences: new ListSequencesQuery(sequences),
        setNextSequence: new SetNextSequenceCommand(sequences),
        setLogo: new SetIssuerLogoCommand(configs, storage),
        deleteLogo: new DeleteIssuerLogoCommand(configs, storage),
        getLogo: new GetIssuerLogoQuery(configs, storage),
        goLive,
      },
      authorizeAs(TENANT_A),
    );

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/company-config/go-live',
      payload: { confirmRuc: '1790000000001', acknowledge: true },
    });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().errors[0].code).toBe('CONFIRMATION_MISMATCH');
    const unchecked = await app.inject({
      method: 'POST',
      url: '/api/company-config/go-live',
      payload: { confirmRuc: RUC_A, acknowledge: false },
    });
    expect(unchecked.statusCode).toBe(400);

    const done = await app.inject({
      method: 'POST',
      url: '/api/company-config/go-live',
      payload: CONFIRM,
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().data.environment).toBe(Environment.PRODUCTION);
    await app.close();
  });
});
