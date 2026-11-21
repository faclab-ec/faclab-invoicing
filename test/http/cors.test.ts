import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHttpServer } from '#/shared/infra/http-server';

// faclab-web (S7.3) sends the W3C trace context with fetch/XHR, so the browser's trace goes on
// in this service: the preflight must allow traceparent and tracestate
const WEB = 'http://localhost:5173';

describe('CORS', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: [WEB],
      serviceName: 'faclab-invoicing',
      serviceVersion: 'test',
    });
    app.get('/api/certificates', async () => ({ data: [] }));
    await app.ready();
  });

  afterAll(() => app.close());

  const preflight = (origin: string) =>
    app.inject({
      method: 'OPTIONS',
      url: '/api/certificates',
      headers: {
        origin,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization, traceparent, tracestate',
      },
    });

  it('lets the web app send the trace context', async () => {
    const response = await preflight(WEB);

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(WEB);
    const allowed = String(response.headers['access-control-allow-headers'])
      .split(',')
      .map((header) => header.trim().toLowerCase());
    expect(allowed).toEqual(expect.arrayContaining(['authorization', 'traceparent', 'tracestate']));
  });

  it('does not allow another origin', async () => {
    const response = await preflight('https://evil.example');

    // Without allow-origin the browser blocks the request, whatever else the preflight says
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
