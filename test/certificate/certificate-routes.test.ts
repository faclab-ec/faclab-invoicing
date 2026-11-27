import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  DeleteCertificateCommand,
  GetCertificateCommand,
  ListCertificatesCommand,
  UploadCertificateCommand,
} from '#/modules/certificate/app/certificate.commands';
import {
  MAX_CERTIFICATE_BYTES,
  registerCertificateRoutes,
} from '#/modules/certificate/infra/http/certificate.routes';
import { createHttpServer } from '#/shared/infra/http-server';

import { authorizeAs, multipartFile, TENANT_A } from '../helpers';

/** The upload route's limits (S9.3): a .p12 is a few KB */
describe('POST /api/certificates', () => {
  let app: FastifyInstance;
  const upload = { execute: vi.fn() };

  beforeAll(async () => {
    app = await createHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: [],
      serviceName: 'test',
      serviceVersion: 'test',
    });
    registerCertificateRoutes(
      app,
      {
        upload: upload as unknown as UploadCertificateCommand,
        get: vi.fn() as unknown as GetCertificateCommand,
        list: vi.fn() as unknown as ListCertificatesCommand,
        delete: vi.fn() as unknown as DeleteCertificateCommand,
      },
      authorizeAs(TENANT_A),
    );
  });

  afterAll(async () => app.close());

  it('refuses a file larger than a certificate without parsing it', async () => {
    const file = multipartFile(
      Buffer.alloc(MAX_CERTIFICATE_BYTES + 1),
      'firma.p12',
      'application/x-pkcs12',
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/certificates',
      headers: file.headers,
      payload: file.payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().errors[0].message).toContain('larger than 64 KB');
    expect(upload.execute).not.toHaveBeenCalled();
  });
});
