import { describe, expect, it } from 'vitest';

import { ReadyIssuer } from '#/modules/company-config/app/issuer-readiness';
import { Environment } from '#/modules/company-config/domain/company-config';
import {
  GetTestInvoiceQuery,
  SubmitTestInvoiceCommand,
} from '#/modules/invoice/app/commands/onboarding-test-invoice';
import { ReceiveSaleCommand } from '#/modules/invoice/app/commands/receive-sale';
import { InvoiceProcessor } from '#/modules/invoice/app/services/invoice-processor';
import { InvoiceStatus } from '#/modules/invoice/domain/invoice';
import { ONBOARDING_SALE_SOURCE } from '#/modules/invoice/domain/sale';
import { registerOnboardingRoutes } from '#/modules/invoice/infra/http/onboarding.routes';
import { createHttpServer } from '#/shared/infra/http-server';

import {
  authorizeAs,
  InMemoryCompanyConfigRepository,
  InMemoryInvoiceRepository,
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

async function setup(environment = Environment.TESTING) {
  const configs = new InMemoryCompanyConfigRepository();
  await configs.save(makeConfig({ environment }));
  const invoices = new InMemoryInvoiceRepository();
  const readiness = readinessStub(READY);
  const submit = new SubmitTestInvoiceCommand(
    configs,
    readiness,
    new ReceiveSaleCommand(invoices),
    invoices,
  );
  const published: unknown[] = [];
  const processor = new InvoiceProcessor(
    invoices,
    invoices,
    invoiceSteps(invoices, readiness),
    readiness,
    { sendMessage: async (event) => void published.push(event) },
  );
  return { configs, invoices, readiness, submit, processor, published };
}

describe('the test invoice of the onboarding (S8.5)', () => {
  it('goes through the pipeline to the SRI test environment and nobody is told', async () => {
    const { submit, processor, invoices, published } = await setup();

    const invoice = await submit.execute(TENANT_A);
    expect(invoice.status).toBe(InvoiceStatus.PENDING);
    expect(invoice.sale?.source).toBe(ONBOARDING_SALE_SOURCE);
    expect(invoice.sale?.customer).toBeNull();
    expect(invoice.point).toMatchObject({ issuerRuc: RUC_A, establishment: '001' });

    const done = await processor.run(invoice.id);

    expect(done?.status).toBe(InvoiceStatus.AUTHORIZED);
    expect(done?.number).toBe('001-001-000000001');
    // It isn't a sale of faclab-core: no `invoices` message, and it is marked as told
    expect(published).toEqual([]);
    expect(done?.resultPublishedAt).not.toBeNull();
    expect((await invoices.findOnboardingTest(TENANT_A))?.id).toBe(invoice.id);
  });

  it('answers the one already in progress or authorized, and makes another after a rejection', async () => {
    const { submit, processor } = await setup();
    const first = await submit.execute(TENANT_A);

    expect((await submit.execute(TENANT_A)).id).toBe(first.id);
    await processor.run(first.id);
    expect((await submit.execute(TENANT_A)).id).toBe(first.id);
  });

  it('is only for the test environment and a ready issuer', async () => {
    const production = await setup(Environment.PRODUCTION);
    await expect(production.submit.execute(TENANT_A)).rejects.toMatchObject({
      code: 'TEST_INVOICE_ONLY_IN_TESTING',
    });

    const { configs, invoices } = await setup();
    const notReady = {
      check: async () => ({
        ready: false,
        taxId: RUC_A,
        environment: Environment.TESTING,
        certificate: null,
        issues: [
          { code: 'CERTIFICATE_NOT_SELECTED', severity: 'error', message: 'Select a certificate' },
        ],
      }),
    } as never;
    const command = new SubmitTestInvoiceCommand(
      configs,
      notReady,
      new ReceiveSaleCommand(invoices),
      invoices,
    );
    await expect(command.execute(TENANT_A)).rejects.toMatchObject({ code: 'ISSUER_NOT_READY' });

    const empty = new SubmitTestInvoiceCommand(
      new InMemoryCompanyConfigRepository(),
      notReady,
      new ReceiveSaleCommand(invoices),
      invoices,
    );
    await expect(empty.execute(TENANT_A)).rejects.toMatchObject({ code: 'ISSUER_NOT_CONFIGURED' });
  });

  it('never shows up as a sale of another company', async () => {
    const { submit, invoices } = await setup();
    await submit.execute(TENANT_A);

    expect(await invoices.findOnboardingTest('11111111-1111-4111-8111-111111111111')).toBeNull();
  });

  describe('over HTTP', () => {
    async function server() {
      const ctx = await setup();
      const app = await createHttpServer({
        port: 0,
        host: '127.0.0.1',
        corsOrigins: [],
        serviceName: 'faclab-invoicing',
        serviceVersion: 'test',
      });
      registerOnboardingRoutes(
        app,
        { submitTestInvoice: ctx.submit, getTestInvoice: new GetTestInvoiceQuery(ctx.invoices) },
        authorizeAs(TENANT_A),
      );
      return { app, ...ctx };
    }

    it('requests it and reads how it goes', async () => {
      const { app, processor, invoices } = await server();
      const none = await app.inject({ method: 'GET', url: '/api/invoicing/test-invoice' });
      expect(none.json().data).toMatchObject({ status: 'NONE', id: null });

      const created = await app.inject({ method: 'POST', url: '/api/invoicing/test-invoice' });
      expect(created.statusCode).toBe(200);
      expect(created.json().data.status).toBe('PROCESSING');
      const {
        items: [{ id }],
      } = await invoices.findPage(TENANT_A, {}, { limit: 10, offset: 0 });
      await processor.run(id);

      const done = await app.inject({ method: 'GET', url: '/api/invoicing/test-invoice' });
      expect(done.json().data).toMatchObject({
        status: 'AUTHORIZED',
        number: '001-001-000000001',
        id,
      });
      await app.close();
    });

    it('takes the emission point of the sale', async () => {
      const { app, invoices } = await server();

      await app.inject({
        method: 'POST',
        url: '/api/invoicing/test-invoice',
        payload: { establishment: '002', emissionPoint: '003' },
      });

      const {
        items: [invoice],
      } = await invoices.findPage(TENANT_A, {}, { limit: 10, offset: 0 });
      expect(invoice.point).toMatchObject({ establishment: '002', emissionPoint: '003' });
      await app.close();
    });

    it('rejects a malformed emission point', async () => {
      const { app } = await server();

      const response = await app.inject({
        method: 'POST',
        url: '/api/invoicing/test-invoice',
        payload: { establishment: '1' },
      });

      expect(response.statusCode).toBe(400);
      await app.close();
    });
  });
});
