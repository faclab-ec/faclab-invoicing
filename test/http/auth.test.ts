import { createHmac } from 'crypto';
import { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { describe, expect, it } from 'vitest';

import {
  AuthError,
  createAuthorize,
  createRequireScope,
  verifyAccessToken,
} from '#/shared/infra/http/auth';
import { JwksKeyStore } from '#/shared/infra/http/jwks';

import { TENANT_A } from '../helpers';
import {
  accessToken,
  AUTH,
  CORE_KEY,
  integrationToken,
  jwkOf,
  publishedKeys,
  signingKey,
} from './tokens';

const invalid = (reason: string) =>
  expect.objectContaining({
    statusCode: 401,
    code: 'INVALID_TOKEN',
    message: `invalid token: ${reason}`,
  });

describe('verifyAccessToken', () => {
  it('reads the company the token was issued for (tid)', async () => {
    const claims = await verifyAccessToken(accessToken({ tid: TENANT_A.toUpperCase() }), AUTH);

    expect(claims).toMatchObject({ userId: '7', username: 'admin', tenantId: TENANT_A });
  });

  it.each([
    ['without tid', {}],
    ['with a tid that is not a uuid', { tid: 'default' }],
  ])('rejects a token %s, like faclab-core', async (_case, claims) => {
    const token = accessToken({ tid: undefined, ...claims });

    await expect(verifyAccessToken(token, AUTH)).rejects.toBeInstanceOf(AuthError);
    await expect(verifyAccessToken(token, AUTH)).rejects.toMatchObject({
      statusCode: 401,
      code: 'TENANT_REQUIRED',
    });
  });

  it('rejects a token signed with a key faclab-core does not publish', async () => {
    const stranger = signingKey('stranger');

    await expect(
      verifyAccessToken(accessToken({ tid: TENANT_A }, { key: stranger }), AUTH),
    ).rejects.toEqual(invalid('unknown key'));
    // Also when it claims the kid of a published key
    await expect(
      verifyAccessToken(
        accessToken({ tid: TENANT_A }, { key: stranger, header: { kid: CORE_KEY.kid } }),
        AUTH,
      ),
    ).rejects.toEqual(invalid('bad signature'));
  });

  it('rejects a token whose key is not in the JWKS even after fetching it again', async () => {
    const fetches: string[] = [];
    const keys = new JwksKeyStore({
      url: 'http://core/.well-known/jwks.json',
      fetchJson: async (url) => {
        fetches.push(url);
        return { keys: [jwkOf(CORE_KEY)] };
      },
      minRefreshMs: 0,
    });

    await expect(
      verifyAccessToken(accessToken({ tid: TENANT_A }, { key: signingKey('other') }), {
        ...AUTH,
        keys,
      }),
    ).rejects.toEqual(invalid('unknown key'));
    // The first load and the retry for the unknown kid
    expect(fetches).toHaveLength(2);
  });

  it.each(['HS256', 'none'])('rejects another algorithm (%s)', async (alg) => {
    const [head, payload] = accessToken({ tid: TENANT_A }, { header: { alg } }).split('.');
    // HS256 keyed with the public key, which anyone can read in the JWKS
    const signature =
      alg === 'none'
        ? ''
        : createHmac('sha256', String(jwkOf(CORE_KEY).x))
            .update(`${head}.${payload}`)
            .digest('base64url');

    await expect(verifyAccessToken(`${head}.${payload}.${signature}`, AUTH)).rejects.toEqual(
      invalid('unsupported algorithm'),
    );
  });

  it('rejects a token without kid', async () => {
    await expect(
      verifyAccessToken(accessToken({ tid: TENANT_A }, { header: { kid: undefined } }), AUTH),
    ).rejects.toEqual(invalid('missing kid'));
  });

  it.each([
    ['without aud', { aud: undefined }],
    ['only for faclab-core (a refresh token)', { aud: 'faclab-core' }],
    ['for other services', { aud: ['faclab-core', 'faclab-other'] }],
  ])('rejects a token %s', async (_case, claims) => {
    await expect(
      verifyAccessToken(accessToken({ tid: TENANT_A, ...claims }), AUTH),
    ).rejects.toEqual(invalid('wrong audience'));
  });

  it('takes an aud that names only this service', async () => {
    const claims = await verifyAccessToken(
      accessToken({ tid: TENANT_A, aud: 'faclab-invoicing' }),
      AUTH,
    );

    expect(claims.tenantId).toBe(TENANT_A);
  });

  it('answers TOKEN_EXPIRED for an expired token and rejects another issuer', async () => {
    const past = Math.floor(Date.now() / 1000) - 1;

    await expect(
      verifyAccessToken(accessToken({ tid: TENANT_A, exp: past }), AUTH),
    ).rejects.toMatchObject({ statusCode: 401, code: 'TOKEN_EXPIRED' });
    await expect(
      verifyAccessToken(accessToken({ tid: TENANT_A, iss: 'someone-else' }), AUTH),
    ).rejects.toEqual(invalid('wrong issuer'));
  });

  it('keeps the sessions of the previous key while a rotation publishes both', async () => {
    const previous = CORE_KEY;
    const current = signingKey('core-key-2');
    const rotating = { ...AUTH, keys: publishedKeys(current, previous) };

    for (const key of [previous, current]) {
      const claims = await verifyAccessToken(accessToken({ tid: TENANT_A }, { key }), rotating);
      expect(claims.tenantId).toBe(TENANT_A);
    }
    // Once the previous key is retired its tokens stop working
    const retired = { ...AUTH, keys: publishedKeys(current) };
    await expect(
      verifyAccessToken(accessToken({ tid: TENANT_A }, { key: previous }), retired),
    ).rejects.toEqual(invalid('unknown key'));
  });

  it('finds the new key of a rotation by fetching the JWKS again', async () => {
    const current = signingKey('core-key-2');
    let published = [jwkOf(CORE_KEY)];
    const keys = new JwksKeyStore({
      url: 'http://core/.well-known/jwks.json',
      fetchJson: async () => ({ keys: published }),
      minRefreshMs: 0,
    });
    const auth = { ...AUTH, keys };
    await verifyAccessToken(accessToken({ tid: TENANT_A }), auth);

    published = [jwkOf(current), jwkOf(CORE_KEY)];

    const claims = await verifyAccessToken(accessToken({ tid: TENANT_A }, { key: current }), auth);
    expect(claims.tenantId).toBe(TENANT_A);
  });
});

describe('integration clients (S6.3)', () => {
  it('reads the client, its scopes and branches instead of permissions', async () => {
    const claims = await verifyAccessToken(
      integrationToken(TENANT_A, { scope: 'invoices:read sales:read', bids: [12, 15] }),
      AUTH,
    );

    expect(claims).toMatchObject({
      tenantId: TENANT_A,
      username: 'fl_test_0123456789ab',
      permissions: [],
      integration: {
        clientId: 'fl_test_0123456789ab',
        scopes: ['invoices:read', 'sales:read'],
        branchIds: [12, 15],
      },
    });
  });

  it('never takes permissions from an integration token', async () => {
    const claims = await verifyAccessToken(
      accessToken({
        sub: 'client:fl_test_x',
        azp: 'fl_test_x',
        tid: TENANT_A,
        perms: ['sale:read'],
      }),
      AUTH,
    );

    expect(claims.permissions).toEqual([]);
    expect(claims.integration?.branchIds).toBeNull();
  });

  it("refuses an integration on the internal API and a person's token on the public one", async () => {
    const app = {} as FastifyInstance;
    const run = (handler: preHandlerAsyncHookHandler, token: string) =>
      handler.call(
        app,
        { headers: { authorization: `Bearer ${token}` }, auth: null } as never,
        {} as never,
      );

    await expect(
      run(createAuthorize(AUTH)('sale:read'), integrationToken(TENANT_A)),
    ).rejects.toMatchObject({ statusCode: 403, code: 'INTEGRATION_NOT_ALLOWED' });
    await expect(
      run(createRequireScope(AUTH)('invoices:read'), accessToken({ tid: TENANT_A })),
    ).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    await expect(
      run(
        createRequireScope(AUTH)('invoices:read'),
        integrationToken(TENANT_A, { scope: 'sales:read' }),
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: 'INSUFFICIENT_SCOPE' });
  });
});
