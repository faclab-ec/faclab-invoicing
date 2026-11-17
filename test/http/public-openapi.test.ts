import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GetAuthorizedXmlQuery, GetRideQuery } from '#/modules/invoice/app/queries/invoice.queries';
import {
  GetPublicInvoiceQuery,
  ListPublicInvoicesQuery,
} from '#/modules/invoice/app/queries/public-invoice.queries';
import { registerPublicInvoiceRoutes } from '#/modules/invoice/infra/http/v1/public-invoice.routes';
import { createRequireScope } from '#/shared/infra/http/auth';
import { publicApiEnabled, publicOpenapi, renderOpenapi } from '#/shared/infra/http/public-api';
import { createRateLimit } from '#/shared/infra/http/rate-limit';
import { createHttpServer } from '#/shared/infra/http-server';

import { AUTH } from './tokens';

// The public API's contract (S6.3): docs/public-api/openapi-v1.json is the published version,
// which the CI compares with the base branch's. `npm run public-openapi` writes it again
const SNAPSHOT = resolve('docs/public-api/openapi-v1.json');

describe('public OpenAPI', () => {
  let spec: Record<string, unknown>;
  const close: (() => Promise<unknown>)[] = [];

  beforeAll(async () => {
    const app = await createHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: [],
      serviceName: 'faclab-invoicing',
      serviceVersion: 'test',
    });
    close.push(() => app.close());
    registerPublicInvoiceRoutes(
      app,
      {
        list: {} as ListPublicInvoicesQuery,
        get: {} as GetPublicInvoiceQuery,
        authorizedXml: {} as GetAuthorizedXmlQuery,
        ride: {} as GetRideQuery,
      },
      {
        enabled: publicApiEnabled(true),
        requireScope: createRequireScope(AUTH),
        rateLimit: createRateLimit(null, {
          client: { perMinute: 600, burst: 50 },
          tenant: { perMinute: 1200, burst: 100 },
        }),
      },
    );
    await app.ready();
    spec = publicOpenapi(app);
    if (process.env.UPDATE_PUBLIC_OPENAPI) {
      mkdirSync(dirname(SNAPSHOT), { recursive: true });
      writeFileSync(SNAPSHOT, renderOpenapi(spec));
    }
  });

  afterAll(async () => {
    for (const fn of close) await fn();
  });

  it('is the snapshot in docs/public-api (npm run public-openapi writes it)', () => {
    expect(renderOpenapi(spec)).toBe(readFileSync(SNAPSHOT, 'utf8'));
  });

  it('documents only the public routes, each with its scope', () => {
    const paths = spec.paths as Record<string, Record<string, { security: unknown }>>;

    expect(Object.keys(paths).sort()).toEqual([
      '/api/v1/invoices',
      '/api/v1/invoices/{id}',
      '/api/v1/invoices/{id}/ride',
      '/api/v1/invoices/{id}/xml',
    ]);
    for (const item of Object.values(paths)) {
      expect(item.get.security).toEqual([{ clientCredentials: ['invoices:read'] }]);
    }
  });
});
