import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  DeleteCertificateCommand,
  GetCertificateCommand,
  ListCertificatesCommand,
  UploadCertificateCommand,
} from '#/modules/certificate/app/certificate.commands';
import { registerCertificateRoutes } from '#/modules/certificate/infra/http/certificate.routes';
import {
  GetCompanyConfigQuery,
  SaveCompanyConfigCommand,
} from '#/modules/company-config/app/company-config.commands';
import {
  DeleteIssuerLogoCommand,
  GetIssuerLogoQuery,
  SetIssuerLogoCommand,
} from '#/modules/company-config/app/issuer-logo.commands';
import {
  ListSequencesQuery,
  SetNextSequenceCommand,
} from '#/modules/company-config/app/sequence.commands';
import { issuerLogoKey } from '#/modules/company-config/domain/logo';
import { INVOICE_DOC_TYPE } from '#/modules/company-config/domain/sequence';
import { registerCompanyConfigRoutes } from '#/modules/company-config/infra/http/company-config.routes';
import {
  RetryInvoiceCommand,
  RetryInvoicesCommand,
} from '#/modules/invoice/app/commands/retry-invoice';
import {
  FindInvoicesBySaleIdQuery,
  GetAuthorizedXmlQuery,
  GetInvoiceQuery,
  GetInvoicingStatusQuery,
  ListInvoicesQuery,
} from '#/modules/invoice/app/queries/invoice.queries';
import { InvoiceProcessor } from '#/modules/invoice/app/services/invoice-processor';
import { InvoiceRecoveryService } from '#/modules/invoice/app/services/invoice-recovery';
import { Invoice } from '#/modules/invoice/domain/invoice';
import { registerInvoiceRoutes } from '#/modules/invoice/infra/http/invoice.routes';
import { createAuthorize } from '#/shared/infra/http/auth';
import { createHttpServer } from '#/shared/infra/http-server';

import {
  InMemoryCertificateRepository,
  InMemoryCompanyConfigRepository,
  InMemoryDocumentStorage,
  InMemoryInvoiceRepository,
  InMemorySequenceRepository,
  makeAuthorizedInvoice,
  makeCertificate,
  makeConfig,
  makePoint,
  makeSale,
  multipartFile,
  readinessStub,
  RUC_A,
  RUC_B,
  TENANT_A,
  TENANT_B,
} from '../helpers';
import { LOGO_PNG, makePng } from '../pdf-text';
import { accessToken, AUTH, bearer } from './tokens';

// Two companies with the same data: an invoice of sale 42, a profile, a certificate and a counter;
// B's invoice is authorized, with its XML kept
const INVOICE_A = '0f9a0d1e-1c2b-4a3d-8e4f-5a6b7c8d9e01';
const INVOICE_B = '0f9a0d1e-1c2b-4a3d-8e4f-5a6b7c8d9e02';
const CERT_A = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b01';
const CERT_B = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b02';

describe('API isolation between companies', () => {
  let app: FastifyInstance;
  const invoices = new InMemoryInvoiceRepository();
  const configs = new InMemoryCompanyConfigRepository();
  const certificates = new InMemoryCertificateRepository();
  const sequences = new InMemorySequenceRepository();
  const storage = new InMemoryDocumentStorage();
  const listener = { issuerChanged: vi.fn() };
  const run = vi.fn();

  beforeAll(async () => {
    const pointB = makePoint({ tenantId: TENANT_B, issuerRuc: RUC_B });
    await invoices.createInvoice(Invoice.receive(INVOICE_A, makePoint(), makeSale()));
    await invoices.createInvoice(await makeAuthorizedInvoice(INVOICE_B, pointB, storage));
    await certificates.save(makeCertificate({ id: CERT_A }));
    await certificates.save(makeCertificate({ id: CERT_B, tenantId: TENANT_B, taxIds: [RUC_B] }));
    await configs.save(makeConfig({ signingCertId: CERT_A }));
    await configs.save(makeConfig({ tenantId: TENANT_B, taxId: RUC_B, signingCertId: CERT_B }));
    await storage.put(issuerLogoKey(TENANT_B), LOGO_PNG, 'image/png');
    await configs.setLogo(TENANT_B, { key: issuerLogoKey(TENANT_B), contentType: 'image/png' });
    for (const [tenantId, next] of [
      [TENANT_A, 10],
      [TENANT_B, 900],
    ] as const) {
      await sequences.setNext(
        { tenantId, establishment: '001', emissionPoint: '001', docType: INVOICE_DOC_TYPE },
        next,
      );
    }

    const readiness = readinessStub(new Error('not used') as never);
    const processor = { run } as unknown as InvoiceProcessor;
    const recovery = { run: vi.fn(async () => 0) } as unknown as InvoiceRecoveryService;
    app = await createHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: ['http://localhost:5173'],
      serviceName: 'faclab-invoicing',
      serviceVersion: 'test',
    });
    const authorize = createAuthorize(AUTH);
    registerInvoiceRoutes(
      app,
      {
        get: new GetInvoiceQuery(invoices),
        authorizedXml: new GetAuthorizedXmlQuery(invoices, storage),
        list: new ListInvoicesQuery(invoices, 'America/Guayaquil'),
        findBySaleId: new FindInvoicesBySaleIdQuery(invoices),
        status: new GetInvoicingStatusQuery(
          readinessStub({
            [TENANT_A]: { config: makeConfig(), certificate: makeCertificate() },
          }),
          invoices,
        ),
        retry: new RetryInvoiceCommand(invoices, invoices, readiness, processor, {
          holder: 'api',
          leaseMs: 60_000,
        }),
        retryAll: new RetryInvoicesCommand(readiness, recovery),
      },
      authorize,
    );
    registerCompanyConfigRoutes(
      app,
      {
        save: new SaveCompanyConfigCommand(configs, certificates, listener),
        get: new GetCompanyConfigQuery(configs),
        listSequences: new ListSequencesQuery(sequences),
        setNextSequence: new SetNextSequenceCommand(sequences),
        setLogo: new SetIssuerLogoCommand(configs, storage),
        deleteLogo: new DeleteIssuerLogoCommand(configs, storage),
        getLogo: new GetIssuerLogoQuery(configs, storage),
      },
      authorize,
    );
    registerCertificateRoutes(
      app,
      {
        upload: vi.fn() as unknown as UploadCertificateCommand,
        get: new GetCertificateCommand(certificates),
        list: new ListCertificatesCommand(certificates),
        delete: new DeleteCertificateCommand(certificates, configs, listener),
      },
      authorize,
    );
  });

  afterAll(async () => app.close());

  const get = (url: string, tenantId = TENANT_A) =>
    app.inject({ method: 'GET', url, headers: bearer(tenantId) });
  const ids = (body: { data: { id: string }[] }) => body.data.map((item) => item.id);

  it('needs a token with a company', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/invoices',
      headers: { authorization: `Bearer ${accessToken({})}` },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().errors[0].code).toBe('TENANT_REQUIRED');
  });

  it("lists and finds only the company's invoices", async () => {
    expect(ids((await get('/api/invoices')).json())).toEqual([INVOICE_A]);
    expect(ids((await get('/api/invoices', TENANT_B)).json())).toEqual([INVOICE_B]);
    expect(ids((await get('/api/invoices/by-sale/42')).json())).toEqual([INVOICE_A]);
    expect((await get(`/api/invoices/${INVOICE_B}`)).statusCode).toBe(404);
    expect((await get(`/api/invoices/${INVOICE_B}`, TENANT_B)).statusCode).toBe(200);
  });

  it("downloads only the company's authorized XML", async () => {
    expect((await get(`/api/invoices/${INVOICE_B}/authorized-xml`)).statusCode).toBe(404);
    expect((await get(`/api/invoices/${INVOICE_B}/authorized-xml`, TENANT_B)).statusCode).toBe(200);
  });

  it("doesn't retry another company's invoice", async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/invoices/${INVOICE_B}/retry`,
      headers: bearer(TENANT_A),
    });

    expect(response.statusCode).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });

  it("reports only the company's issuer and invoices", async () => {
    const ofA = (await get('/api/invoicing/status')).json().data;
    const ofB = (await get('/api/invoicing/status', TENANT_B)).json().data;

    expect(ofA).toMatchObject({ ready: true, pendingInvoices: 1 });
    // B's issuer isn't ready, which doesn't change A's answer; its invoice is authorized
    expect(ofB).toMatchObject({ ready: false, pendingInvoices: 0 });
  });

  it("reads and writes only the company's fiscal profile", async () => {
    expect((await get('/api/company-config')).json().data.taxId).toBe(RUC_A);
    expect((await get('/api/company-config', TENANT_B)).json().data.taxId).toBe(RUC_B);

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/company-config',
      headers: bearer(TENANT_A),
      payload: {
        taxId: RUC_A,
        name: 'ACME RENOMBRADA',
        tradeName: 'ACME',
        mainAddress: 'Quito',
        environment: 1,
        emissionType: 1,
        // Another company's certificate is not found
        signingCertId: CERT_B,
      },
    });

    expect(saved.statusCode).toBe(422);
    expect((await configs.find(TENANT_B))?.signingCertId).toBe(CERT_B);
  });

  it("reads, replaces and removes only the company's logo", async () => {
    // A has none: it never gets B's
    expect((await get('/api/company-config/logo')).statusCode).toBe(404);
    expect((await get('/api/company-config/logo', TENANT_B)).rawPayload).toEqual(LOGO_PNG);

    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/company-config/logo',
      headers: bearer(TENANT_A),
    });
    expect(removed.statusCode).toBe(204);
    expect((await configs.find(TENANT_B))?.logo).not.toBeNull();

    const upload = multipartFile(makePng(10, 10));
    const uploaded = await app.inject({
      method: 'PUT',
      url: '/api/company-config/logo',
      headers: { ...bearer(TENANT_A), ...upload.headers },
      payload: upload.payload,
    });
    expect(uploaded.statusCode).toBe(200);
    expect(await storage.getBytes(issuerLogoKey(TENANT_A))).toEqual(makePng(10, 10));
    expect(await storage.getBytes(issuerLogoKey(TENANT_B))).toEqual(LOGO_PNG);
  });

  it("lists, finds and deletes only the company's certificates", async () => {
    expect(ids((await get('/api/certificates')).json())).toEqual([CERT_A]);
    expect((await get(`/api/certificates/${CERT_B}`)).statusCode).toBe(404);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/certificates/${CERT_B}`,
      headers: bearer(TENANT_A),
    });

    expect(deleted.statusCode).toBe(404);
    expect(await certificates.findById(TENANT_B, CERT_B)).not.toBeNull();
  });

  it("lists and sets only the company's sequences", async () => {
    const listed = (await get('/api/sequences')).json().data;
    expect(listed).toEqual([
      {
        establishment: '001',
        emissionPoint: '001',
        docType: '01',
        lastSequence: '000000009',
        nextSequence: 10,
      },
    ]);

    const set = await app.inject({
      method: 'PUT',
      url: '/api/sequences/001/001',
      headers: bearer(TENANT_A),
      payload: { nextSequence: 20 },
    });

    expect(set.json().data.nextSequence).toBe(20);
    expect((await get('/api/sequences', TENANT_B)).json().data[0].nextSequence).toBe(900);
  });

  it("refuses to move a company's sequence back", async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/sequences/001/001',
      headers: bearer(TENANT_B),
      payload: { nextSequence: 5 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().errors[0].code).toBe('SEQUENCE_CANNOT_GO_BACK');
  });
});
