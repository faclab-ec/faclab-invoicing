import { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { registerCompanyConfigRoutes } from '#/modules/company-config/infra/http/company-config.routes';
import { createHttpServer } from '#/shared/infra/http-server';

import {
  authorizeAs,
  InMemoryCertificateRepository,
  InMemoryCompanyConfigRepository,
  InMemoryDocumentStorage,
  InMemorySequenceRepository,
  makeConfig,
  multipartFile,
  RUC_A,
  TENANT_A,
} from '../helpers';
import { LOGO_PNG, makePng } from '../pdf-text';

describe('the issuer logo of the RIDE', () => {
  let app: FastifyInstance;
  let configs: InMemoryCompanyConfigRepository;
  let storage: InMemoryDocumentStorage;

  beforeEach(async () => {
    configs = new InMemoryCompanyConfigRepository();
    storage = new InMemoryDocumentStorage();
    const sequences = new InMemorySequenceRepository();
    app = await createHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: [],
      serviceName: 'faclab-invoicing',
      serviceVersion: 'test',
    });
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
      },
      authorizeAs(TENANT_A),
    );
  });

  afterEach(async () => app.close());

  const upload = (bytes: Buffer, filename?: string, type?: string) => {
    const body = multipartFile(bytes, filename, type);
    return app.inject({
      method: 'PUT',
      url: '/api/company-config/logo',
      headers: body.headers,
      payload: body.payload,
    });
  };
  const code = (response: { json(): { errors: { code: string }[] } }) =>
    response.json().errors[0].code;

  it('needs the fiscal profile first', async () => {
    const response = await upload(LOGO_PNG);

    expect(response.statusCode).toBe(409);
    expect(code(response)).toBe('ISSUER_NOT_CONFIGURED');
    expect(storage.objects.size).toBe(0);
  });

  it('keeps a PNG or JPEG under the company and answers the profile with it', async () => {
    await configs.save(makeConfig());
    const response = await upload(LOGO_PNG);

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ taxId: RUC_A, hasLogo: true });
    expect(storage.objects.get(issuerLogoKey(TENANT_A))).toEqual({
      body: LOGO_PNG,
      contentType: 'image/png',
    });

    const downloaded = await app.inject({ method: 'GET', url: '/api/company-config/logo' });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers['content-type']).toBe('image/png');
    expect(downloaded.rawPayload).toEqual(LOGO_PNG);
  });

  it('refuses what the RIDE cannot draw, and files over 300 KB', async () => {
    await configs.save(makeConfig());

    const notImage = await upload(Buffer.from('<svg/>'), 'logo.svg', 'image/svg+xml');
    expect(notImage.statusCode).toBe(422);
    expect(code(notImage)).toBe('LOGO_INVALID');

    const tooLarge = await upload(Buffer.alloc(301 * 1024, 1));
    expect(tooLarge.statusCode).toBe(422);
    expect(code(tooLarge)).toBe('LOGO_TOO_LARGE');

    const tooWide = await upload(makePng(2100, 1));
    expect(code(tooWide)).toBe('LOGO_INVALID');
    expect((await configs.find(TENANT_A))?.logo).toBeNull();
  });

  it('asks for the file as multipart', async () => {
    await configs.save(makeConfig());
    const response = await app.inject({
      method: 'PUT',
      url: '/api/company-config/logo',
      payload: { file: 'x' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('answers 503 when the storage is down, without touching the profile', async () => {
    await configs.save(makeConfig());
    storage.failing = true;
    const response = await upload(LOGO_PNG);

    expect(response.statusCode).toBe(503);
    expect(code(response)).toBe('STORAGE_UNAVAILABLE');
    expect((await configs.find(TENANT_A))?.logo).toBeNull();
  });

  it('keeps the logo when the profile is saved again, with its email', async () => {
    await configs.save(makeConfig());
    await upload(LOGO_PNG);
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/company-config',
      payload: {
        taxId: RUC_A,
        name: 'ACME S.A.',
        tradeName: 'ACME',
        mainAddress: 'Quito',
        environment: 1,
        emissionType: 1,
        email: 'ventas@acme.ec',
      },
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json().data).toMatchObject({ email: 'ventas@acme.ec', hasLogo: true });
  });

  it('refuses an email that is not one', async () => {
    await configs.save(makeConfig());
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/company-config',
      payload: {
        taxId: RUC_A,
        name: 'ACME S.A.',
        tradeName: 'ACME',
        mainAddress: 'Quito',
        environment: 1,
        emissionType: 1,
        email: 'ventas@acme.ec, otro@x.ec',
      },
    });

    expect(saved.statusCode).toBe(400);
  });

  it('removes the logo, also when there is none', async () => {
    await configs.save(makeConfig());
    await upload(LOGO_PNG);

    const removed = await app.inject({ method: 'DELETE', url: '/api/company-config/logo' });
    expect(removed.statusCode).toBe(204);
    expect(storage.objects.has(issuerLogoKey(TENANT_A))).toBe(false);
    expect(
      (await app.inject({ method: 'GET', url: '/api/company-config' })).json().data.hasLogo,
    ).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/api/company-config/logo' })).statusCode).toBe(
      404,
    );

    expect(
      (await app.inject({ method: 'DELETE', url: '/api/company-config/logo' })).statusCode,
    ).toBe(204);
  });
});
