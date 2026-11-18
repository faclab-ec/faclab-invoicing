import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GetAuthorizedXmlQuery, GetRideQuery } from '#/modules/invoice/app/queries/invoice.queries';
import {
  GetPublicInvoiceQuery,
  ListPublicInvoicesQuery,
} from '#/modules/invoice/app/queries/public-invoice.queries';
import { RideService } from '#/modules/invoice/app/services/ride-service';
import { Invoice } from '#/modules/invoice/domain/invoice';
import { PdfKitRideRenderer } from '#/modules/invoice/infra/adapters/pdfkit-ride-renderer';
import { registerPublicInvoiceRoutes } from '#/modules/invoice/infra/http/v1/public-invoice.routes';
import { createAuthorize, createRequireScope } from '#/shared/infra/http/auth';
import { publicApiEnabled } from '#/shared/infra/http/public-api';
import {
  admit,
  binding,
  createRateLimit,
  Decision,
  RateLimit,
  RateLimiter,
} from '#/shared/infra/http/rate-limit';
import { createHttpServer } from '#/shared/infra/http-server';

import {
  InMemoryCompanyConfigRepository,
  InMemoryDocumentStorage,
  InMemoryInvoiceRepository,
  makeAuthorizedInvoice,
  makeConfig,
  makePoint,
  makeSale,
  RUC_B,
  TENANT_A,
  TENANT_B,
} from '../helpers';
import { AUTH, bearer, integrationBearer } from './tokens';

// The public API of the documents (S6.3): company A has an authorized invoice of branch 12, a
// pending one of branch 15 and one from before branches were kept; B has one of branch 12
const AUTHORIZED_12 = '0f9a0d1e-1c2b-4a3d-8e4f-5a6b7c8d9e11';
const PENDING_15 = '0f9a0d1e-1c2b-4a3d-8e4f-5a6b7c8d9e12';
const WITHOUT_BRANCH = '0f9a0d1e-1c2b-4a3d-8e4f-5a6b7c8d9e13';
const OF_B = '0f9a0d1e-1c2b-4a3d-8e4f-5a6b7c8d9e14';

/** The same GCRA in memory: one bucket per key. Unless `frozen`, ten seconds go by between
 * requests, so only the test of the limits reaches them */
class InMemoryRateLimiter implements RateLimiter {
  tats = new Map<string, number>();
  now = 1000;
  frozen = false;

  async check(keys: [string, RateLimit][]): Promise<Decision> {
    if (!this.frozen) this.now += 10;
    const decisions: Decision[] = [];
    for (const [key, limit] of keys) {
      const { decision, tat } = admit(limit, this.tats.get(key) ?? null, this.now);
      this.tats.set(key, tat);
      decisions.push(decision);
      if (!decision.allowed) break;
    }
    return binding(decisions);
  }
}

describe('public API: /api/v1/invoices', () => {
  let app: FastifyInstance;
  const invoices = new InMemoryInvoiceRepository();
  const storage = new InMemoryDocumentStorage();
  const configs = new InMemoryCompanyConfigRepository();
  const limiter = new InMemoryRateLimiter();
  let enabled = true;

  beforeAll(async () => {
    await invoices.createInvoice(
      await makeAuthorizedInvoice(AUTHORIZED_12, makePoint({ branchId: 12 }), storage),
    );
    await invoices.createInvoice(
      Invoice.receive(PENDING_15, makePoint({ branchId: 15 }), makeSale({ sale_id: 43 })),
    );
    await invoices.createInvoice(
      Invoice.receive(WITHOUT_BRANCH, makePoint(), makeSale({ sale_id: 44 })),
    );
    await invoices.createInvoice(
      Invoice.receive(
        OF_B,
        makePoint({ tenantId: TENANT_B, issuerRuc: RUC_B, branchId: 12 }),
        makeSale(),
      ),
    );
    await configs.save(makeConfig());

    app = await createHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: ['http://localhost:5173'],
      serviceName: 'faclab-invoicing',
      serviceVersion: 'test',
    });
    registerPublicInvoiceRoutes(
      app,
      {
        list: new ListPublicInvoicesQuery(invoices),
        get: new GetPublicInvoiceQuery(invoices),
        authorizedXml: new GetAuthorizedXmlQuery(invoices, storage),
        ride: new GetRideQuery(
          invoices,
          new RideService(storage, configs, new PdfKitRideRenderer(), 'America/Guayaquil'),
        ),
      },
      {
        enabled: async (request, reply) => publicApiEnabled(enabled).call(app, request, reply),
        requireScope: createRequireScope(AUTH),
        rateLimit: createRateLimit(limiter, {
          client: { perMinute: 60, burst: 3 },
          tenant: { perMinute: 600, burst: 50 },
        }),
      },
    );
    // An internal route, to check an integration can't use it
    app.get(
      '/api/invoices',
      { preHandler: createAuthorize(AUTH)('sale:read') },
      async (_request, reply) => reply.success([]),
    );
  });

  beforeEach(() => {
    limiter.tats.clear();
    limiter.frozen = false;
    enabled = true;
  });

  afterAll(async () => app.close());

  const get = (url: string, headers: Record<string, string> = integrationBearer(TENANT_A)) =>
    app.inject({ method: 'GET', url, headers });
  const ids = (response: { json: () => { data: { id: string }[] } }) =>
    response
      .json()
      .data.map((d) => d.id)
      .sort();

  it("lists the company's documents with its own contract", async () => {
    const response = await get('/api/v1/invoices');

    expect(response.statusCode).toBe(200);
    expect(ids(response)).toEqual([AUTHORIZED_12, PENDING_15, WITHOUT_BRANCH].sort());
    const authorized = response.json().data.find((d: { id: string }) => d.id === AUTHORIZED_12);
    expect(authorized).toEqual({
      id: AUTHORIZED_12,
      documentType: 'INVOICE',
      saleId: 42,
      creditedInvoiceId: null,
      branchId: 12,
      establishment: '001',
      emissionPoint: '001',
      number: '001-001-000000001',
      accessCode: expect.stringMatching(/^\d{49}$/),
      status: 'AUTHORIZED',
      authorizationNumber: expect.any(String),
      authorizedAt: expect.any(String),
      rejectionReason: null,
      total: '11.50',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(response.json().meta.pagination).toEqual({ total: 3, limit: 50, offset: 0 });
  });

  it('filters by status, sale and branch', async () => {
    expect(ids(await get('/api/v1/invoices?status=PROCESSING'))).toEqual(
      [PENDING_15, WITHOUT_BRANCH].sort(),
    );
    expect(ids(await get('/api/v1/invoices?saleId=43'))).toEqual([PENDING_15]);
    expect(ids(await get('/api/v1/invoices?branchId=12'))).toEqual([AUTHORIZED_12]);
  });

  it('shows a client limited to branches only their documents', async () => {
    const limited = integrationBearer(TENANT_A, { bids: [12] });

    expect(ids(await get('/api/v1/invoices', limited))).toEqual([AUTHORIZED_12]);
    expect((await get(`/api/v1/invoices/${PENDING_15}`, limited)).statusCode).toBe(404);
    expect((await get(`/api/v1/invoices/${WITHOUT_BRANCH}`, limited)).statusCode).toBe(404);
    const other = await get('/api/v1/invoices?branchId=15', limited);
    expect(other.statusCode).toBe(403);
    expect(other.json().errors[0].code).toBe('BRANCH_ACCESS_DENIED');
  });

  it("never shows another company's document", async () => {
    expect((await get(`/api/v1/invoices/${OF_B}`)).statusCode).toBe(404);
    expect(ids(await get('/api/v1/invoices', integrationBearer(TENANT_B)))).toEqual([OF_B]);
  });

  it('downloads the authorized XML and RIDE, and nothing before it', async () => {
    const xml = await get(`/api/v1/invoices/${AUTHORIZED_12}/xml`);
    const ride = await get(`/api/v1/invoices/${AUTHORIZED_12}/ride`);
    const pending = await get(`/api/v1/invoices/${PENDING_15}/xml`);

    expect(xml.statusCode).toBe(200);
    expect(xml.headers['content-type']).toContain('application/xml');
    expect(ride.statusCode).toBe(200);
    expect(ride.headers['content-type']).toBe('application/pdf');
    expect(pending.statusCode).toBe(404);
  });

  it('syncs in a stable order by update time', async () => {
    const response = await get('/api/v1/invoices?updatedSince=2000-01-01T00:00:00Z&limit=2');
    const rest = await get('/api/v1/invoices?updatedSince=2000-01-01T00:00:00Z&limit=2&offset=2');

    const seen = [...response.json().data, ...rest.json().data];
    expect(seen).toHaveLength(3);
    const times = seen.map((d: { updatedAt: string }) => d.updatedAt);
    expect(times).toEqual([...times].sort());
  });

  it('answers 422 to an invalid filter, like the rest of the public API', async () => {
    const response = await get('/api/v1/invoices?sort=total');

    expect(response.statusCode).toBe(422);
    expect(response.json().errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('needs an integration with invoices:read', async () => {
    const person = await get('/api/v1/invoices', bearer(TENANT_A));
    const noScope = await get('/api/v1/invoices', integrationBearer(TENANT_A, { scope: 'x' }));
    const internal = await get('/api/invoices');

    expect([person.statusCode, person.json().errors[0].code]).toEqual([403, 'PERMISSION_DENIED']);
    expect(noScope.json().errors[0].code).toBe('INSUFFICIENT_SCOPE');
    expect([internal.statusCode, internal.json().errors[0].code]).toEqual([
      403,
      'INTEGRATION_NOT_ALLOWED',
    ]);
  });

  it('limits the requests of a client, with Retry-After', async () => {
    limiter.frozen = true;
    const responses = [];
    for (let i = 0; i < 4; i++) responses.push(await get('/api/v1/invoices'));

    expect(responses.slice(0, 3).map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(responses[0].headers['ratelimit-limit']).toBe('3');
    expect(responses[0].headers['ratelimit-remaining']).toBe('2');
    expect(responses[0].headers['ratelimit-policy']).toBe('3;w=3');
    expect(responses[3].statusCode).toBe(429);
    expect(responses[3].headers['retry-after']).toBe('1');
    expect(responses[3].json().errors[0].code).toBe('RATE_LIMITED');
  });

  it('can be turned off', async () => {
    enabled = false;

    const response = await get('/api/v1/invoices');

    expect(response.statusCode).toBe(503);
    expect(response.json().errors[0].code).toBe('PUBLIC_API_DISABLED');
  });
});
