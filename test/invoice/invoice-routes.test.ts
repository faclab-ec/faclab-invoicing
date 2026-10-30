import { afterEach, describe, expect, it, vi } from 'vitest';

import { issuerLogoKey } from '#/modules/company-config/domain/logo';
import {
  RetryInvoiceCommand,
  RetryInvoicesCommand,
} from '#/modules/invoice/app/commands/retry-invoice';
import {
  FindInvoicesBySaleIdQuery,
  GetAuthorizedXmlQuery,
  GetInvoiceQuery,
  GetInvoicingStatusQuery,
  GetRideQuery,
  ListInvoicesQuery,
} from '#/modules/invoice/app/queries/invoice.queries';
import { RideService } from '#/modules/invoice/app/services/ride-service';
import { rideKey } from '#/modules/invoice/domain/authorized-xml';
import { Invoice } from '#/modules/invoice/domain/invoice';
import { PdfKitRideRenderer } from '#/modules/invoice/infra/adapters/pdfkit-ride-renderer';
import { registerInvoiceRoutes } from '#/modules/invoice/infra/http/invoice.routes';
import { createHttpServer } from '#/shared/infra/http-server';

import {
  authorizeAs,
  InMemoryCompanyConfigRepository,
  InMemoryDocumentStorage,
  InMemoryInvoiceRepository,
  makeAuthorizedInvoice,
  makeConfig,
  makePoint,
  makeSale,
  TENANT_A,
  TEST_ACCESS_CODE,
} from '../helpers';
import { LOGO_PNG, pdfImageCount, pdfText } from '../pdf-text';

async function server(
  repo: InMemoryInvoiceRepository,
  storage: InMemoryDocumentStorage = new InMemoryDocumentStorage(),
  configs: InMemoryCompanyConfigRepository = new InMemoryCompanyConfigRepository(),
) {
  const rides = new RideService(
    storage,
    configs,
    new PdfKitRideRenderer({ compress: false }),
    'America/Guayaquil',
  );
  const app = await createHttpServer({
    port: 0,
    host: '127.0.0.1',
    corsOrigins: ['http://localhost:5173'],
    serviceName: 'faclab-invoicing',
    serviceVersion: 'test',
  });
  registerInvoiceRoutes(
    app,
    {
      get: new GetInvoiceQuery(repo),
      authorizedXml: new GetAuthorizedXmlQuery(repo, storage),
      ride: new GetRideQuery(repo, rides),
      list: new ListInvoicesQuery(repo, 'America/Guayaquil'),
      findBySaleId: new FindInvoicesBySaleIdQuery(repo),
      status: vi.fn() as unknown as GetInvoicingStatusQuery,
      retry: vi.fn() as unknown as RetryInvoiceCommand,
      retryAll: vi.fn() as unknown as RetryInvoicesCommand,
    },
    authorizeAs(),
  );
  return app;
}

describe('GET /api/invoices', () => {
  let app: Awaited<ReturnType<typeof server>> | undefined;
  afterEach(async () => app?.close());

  async function withInvoices(count: number) {
    const repo = new InMemoryInvoiceRepository();
    for (let n = 1; n <= count; n++) {
      const at = new Date(Date.UTC(2026, 9, n, 15));
      await repo.createInvoice(
        Invoice.receive(`inv-${n}`, makePoint(), makeSale({ sale_id: n }), at),
      );
    }
    app = await server(repo);
    return app;
  }

  it('returns one page in data and the total in meta.pagination', async () => {
    const response = await (await withInvoices(3)).inject('/api/invoices?limit=2&offset=1');

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.map((invoice: { id: string }) => invoice.id)).toEqual(['inv-2', 'inv-1']);
    expect(body.data[0].statusHistory).toHaveLength(1);
    expect(body.meta.pagination).toEqual({ total: 3, limit: 2, offset: 1 });
    expect(body.meta.requestId).toBeDefined();
  });

  it('defaults to the first 100', async () => {
    const response = await (await withInvoices(1)).inject('/api/invoices');

    expect(response.json().meta.pagination).toEqual({ total: 1, limit: 100, offset: 0 });
  });

  it('filters by status and attention', async () => {
    const api = await withInvoices(2);

    const rejected = await api.inject('/api/invoices?status=rejected');
    const attention = await api.inject('/api/invoices?attention=true');

    expect(rejected.json().meta.pagination.total).toBe(0);
    expect(attention.json().meta.pagination.total).toBe(2);
  });

  it('rejects a limit out of range or a malformed date', async () => {
    const api = await withInvoices(0);

    expect((await api.inject('/api/invoices?limit=0')).statusCode).toBe(400);
    expect((await api.inject('/api/invoices?limit=1001')).statusCode).toBe(400);
    expect((await api.inject('/api/invoices?fromDate=02-10-2026')).statusCode).toBe(400);
  });
});

describe('GET /api/invoices/:id/authorized-xml', () => {
  let app: Awaited<ReturnType<typeof server>> | undefined;
  afterEach(async () => app?.close());

  const AUTHORIZED = '7c0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a';
  const PENDING = '7c0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2b';
  const BEFORE_S41 = '7c0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2c';
  const MISSING = '7c0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2e';

  async function withInvoices() {
    const repo = new InMemoryInvoiceRepository();
    const storage = new InMemoryDocumentStorage();
    await repo.createInvoice(await makeAuthorizedInvoice(AUTHORIZED, makePoint(), storage));
    await repo.createInvoice(Invoice.receive(PENDING, makePoint(), makeSale({ sale_id: 2 })));
    // Authorized before S4.1: the SRI's answer wasn't kept
    const old = await makeAuthorizedInvoice(
      BEFORE_S41,
      makePoint(),
      null,
      makeSale({ sale_id: 3 }),
    );
    await repo.createInvoice(old);
    Object.assign(repo.records.get(BEFORE_S41)!, {
      authorization_number: null,
      authorized_at: null,
      authorized_xml_key: null,
    });
    // Its key is saved but the object isn't in the storage
    const lost = await makeAuthorizedInvoice(MISSING, makePoint(), null, makeSale({ sale_id: 4 }));
    await repo.createInvoice(lost);
    repo.records.get(MISSING)!.authorized_xml_key =
      `tenants/${lost.tenantId}/invoices/2026/lost.xml`;
    app = await server(repo, storage);
    return app;
  }

  it('answers the authorized XML as a file named after the access code', async () => {
    const response = await (
      await withInvoices()
    ).inject(`/api/invoices/${AUTHORIZED}/authorized-xml`);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/xml; charset=utf-8');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="${TEST_ACCESS_CODE}.xml"`,
    );
    expect(response.body).toBe('<autorizacion><estado>AUTORIZADO</estado></autorizacion>');
  });

  it.each([
    ['not authorized yet', PENDING],
    ['authorized before its XML was kept', BEFORE_S41],
    ['whose XML is not in the storage', MISSING],
    ['unknown', '7c0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2d'],
  ])('answers 404 for an invoice %s', async (_case, id) => {
    const response = await (await withInvoices()).inject(`/api/invoices/${id}/authorized-xml`);

    expect(response.statusCode).toBe(404);
  });

  it('shows the authorization number and date in the invoice', async () => {
    const response = await (await withInvoices()).inject(`/api/invoices/${AUTHORIZED}`);

    expect(response.json().data).toMatchObject({
      status: 'authorized',
      authorizationNumber: TEST_ACCESS_CODE,
      authorizedAt: '2026-10-09T15:01:02.000Z',
    });
  });
});

describe('GET /api/invoices/:id/ride', () => {
  let app: Awaited<ReturnType<typeof server>> | undefined;
  afterEach(async () => app?.close());

  const AUTHORIZED = '7c0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a';
  const PENDING = '7c0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2b';
  const BEFORE_S41 = '7c0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2c';
  const RIDE_KEY = rideKey(TENANT_A, '2026', TEST_ACCESS_CODE);

  async function withInvoices(configs = new InMemoryCompanyConfigRepository()) {
    const repo = new InMemoryInvoiceRepository();
    const storage = new InMemoryDocumentStorage();
    await repo.createInvoice(await makeAuthorizedInvoice(AUTHORIZED, makePoint(), storage));
    await repo.createInvoice(Invoice.receive(PENDING, makePoint(), makeSale({ sale_id: 2 })));
    await repo.createInvoice(
      await makeAuthorizedInvoice(BEFORE_S41, makePoint(), null, makeSale({ sale_id: 3 })),
    );
    Object.assign(repo.records.get(BEFORE_S41)!, {
      authorization_number: null,
      authorized_at: null,
      authorized_xml_key: null,
    });
    app = await server(repo, storage, configs);
    return { api: app, storage };
  }

  it('answers the RIDE as a PDF named after the access code, and keeps it', async () => {
    const { api, storage } = await withInvoices();
    const response = await api.inject(`/api/invoices/${AUTHORIZED}/ride`);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="${TEST_ACCESS_CODE}.pdf"`,
    );
    const text = pdfText(response.rawPayload);
    expect(text).toContain('NÚMERO DE AUTORIZACIÓN');
    expect(text).toContain(TEST_ACCESS_CODE);
    expect(storage.objects.get(RIDE_KEY)).toEqual({
      body: response.rawPayload,
      contentType: 'application/pdf',
    });
  });

  it('answers the RIDE it kept, without drawing it again', async () => {
    const { api, storage } = await withInvoices();
    await storage.put(RIDE_KEY, Buffer.from('%PDF-kept'), 'application/pdf');

    const response = await api.inject(`/api/invoices/${AUTHORIZED}/ride`);

    expect(response.rawPayload.toString()).toBe('%PDF-kept');
  });

  it("draws the company's logo", async () => {
    const configs = new InMemoryCompanyConfigRepository();
    await configs.save(makeConfig());
    const withoutLogo = await withInvoices(configs);
    const plain = pdfImageCount(
      (await withoutLogo.api.inject(`/api/invoices/${AUTHORIZED}/ride`)).rawPayload,
    );
    await app!.close();

    await configs.setLogo(TENANT_A, { key: issuerLogoKey(TENANT_A), contentType: 'image/png' });
    const withLogo = await withInvoices(configs);
    await withLogo.storage.put(issuerLogoKey(TENANT_A), LOGO_PNG, 'image/png');
    const response = await withLogo.api.inject(`/api/invoices/${AUTHORIZED}/ride`);

    expect(pdfImageCount(response.rawPayload)).toBeGreaterThan(plain);
  });

  it.each([
    ['not authorized yet', PENDING],
    ['authorized before S4.1', BEFORE_S41],
    ['unknown', '7c0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2d'],
  ])('answers 404 for an invoice %s', async (_case, id) => {
    const { api } = await withInvoices();

    expect((await api.inject(`/api/invoices/${id}/ride`)).statusCode).toBe(404);
  });

  it('answers 503 when the storage is down', async () => {
    const { api, storage } = await withInvoices();
    storage.failing = true;
    const response = await api.inject(`/api/invoices/${AUTHORIZED}/ride`);

    expect(response.statusCode).toBe(503);
    expect(response.json().errors[0].code).toBe('STORAGE_UNAVAILABLE');
  });
});
