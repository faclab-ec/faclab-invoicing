import { randomUUID } from 'crypto';
import { FastifyInstance, RouteOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { registerCertificateRoutes } from '#/modules/certificate/infra/http/certificate.routes';
import { registerCompanyConfigRoutes } from '#/modules/company-config/infra/http/company-config.routes';
import { registerInvoiceRoutes } from '#/modules/invoice/infra/http/invoice.routes';
import { registerOnboardingRoutes } from '#/modules/invoice/infra/http/onboarding.routes';
import { registerPublicInvoiceRoutes } from '#/modules/invoice/infra/http/v1/public-invoice.routes';
import { createAuthorize, createRequireScope } from '#/shared/infra/http/auth';
import { publicApiEnabled } from '#/shared/infra/http/public-api';
import { createRateLimit } from '#/shared/infra/http/rate-limit';
import { createHttpServer } from '#/shared/infra/http-server';

import { TENANT_A } from '../helpers';
import { accessToken, AUTH, integrationToken } from './tokens';

/**
 * No route of the modules lets through a request without a token, a user without permissions or
 * an integration without the scope (S9.3), like faclab-core's test_all_*_routes_require_auth: a
 * route registered without its guard fails here. The schemas are taken out, so a body or a path
 * the route would refuse doesn't answer before the guard; the handlers are never reached. The
 * service's own public routes (/health, /docs) are registered by createHttpServer, before these.
 */
describe('route guards', () => {
  let app: FastifyInstance;
  const routes: { method: string; url: string }[] = [];
  const handler = vi.fn();
  const handlers = new Proxy({}, { get: () => ({ execute: handler }) }) as never;

  beforeAll(async () => {
    app = await createHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: [],
      serviceName: 'faclab-invoicing',
      serviceVersion: 'test',
    });
    app.addHook('onRoute', (route: RouteOptions) => {
      route.schema = undefined;
      for (const method of [route.method].flat()) {
        if (method !== 'HEAD') routes.push({ method, url: route.url });
      }
    });
    const authorize = createAuthorize(AUTH);
    registerInvoiceRoutes(app, handlers, authorize);
    registerOnboardingRoutes(app, handlers, authorize);
    registerCompanyConfigRoutes(app, handlers, authorize);
    registerCertificateRoutes(app, handlers, authorize);
    registerPublicInvoiceRoutes(app, handlers, {
      enabled: publicApiEnabled(true),
      requireScope: createRequireScope(AUTH),
      rateLimit: createRateLimit(null, {
        client: { perMinute: 600, burst: 50 },
        tenant: { perMinute: 1200, burst: 100 },
      }),
    });
    await app.ready();
  });

  afterAll(async () => app.close());

  const call = async (route: { method: string; url: string }, token?: string) => {
    const response = await app.inject({
      method: route.method as 'GET',
      url: route.url.replace(/:\w+/g, () => randomUUID()),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return `${route.method} ${route.url}: ${response.statusCode} ${response.json().errors?.[0]?.code}`;
  };

  it('finds the routes of every module', () => {
    expect(routes.length).toBeGreaterThan(25);
  });

  it.each([
    ['no token', undefined, ['PERMISSION_DENIED']],
    [
      'a user without permissions',
      accessToken({ tid: TENANT_A, perms: [] }),
      ['PERMISSION_DENIED'],
    ],
    [
      'an integration without the scope',
      integrationToken(TENANT_A, { scope: 'stock:read' }),
      ['INTEGRATION_NOT_ALLOWED', 'INSUFFICIENT_SCOPE'],
    ],
  ])('refuses %s on every route', async (_, token, codes) => {
    const answers = await Promise.all(routes.map((route) => call(route, token)));

    const allowed = codes.map((code) => `: 403 ${code}`);
    expect(answers.filter((answer) => !allowed.some((end) => answer.endsWith(end)))).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
  });
});
