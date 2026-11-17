import { describe, expect, it } from 'vitest';

import { AuthUnavailableError, JwksKeyStore, parseJwks } from '#/shared/infra/http/jwks';

import { CORE_KEY, jwkOf, signingKey } from './tokens';

const URL = 'http://faclab-core/.well-known/jwks.json';

/** A JWKS endpoint whose answer the test changes, counting the fetches */
function core(initial: unknown[] = [jwkOf(CORE_KEY)]) {
  const state = { keys: initial, down: false, fetches: 0 };
  const fetchJson = async () => {
    state.fetches += 1;
    if (state.down) throw new Error('connect ECONNREFUSED');
    return { keys: state.keys };
  };
  return { state, fetchJson };
}

function clock(start = 1_000_000) {
  const time = { now: start };
  return { time, now: () => time.now };
}

describe('JwksKeyStore', () => {
  it('fetches the JWKS once and serves the keys from memory', async () => {
    const { state, fetchJson } = core();
    const keys = new JwksKeyStore({ url: URL, fetchJson });

    expect(await keys.key(CORE_KEY.kid)).toBeDefined();
    expect(await keys.key(CORE_KEY.kid)).toBeDefined();
    expect(state.fetches).toBe(1);
  });

  it('shares one fetch among requests that arrive together', async () => {
    const { state, fetchJson } = core();
    const keys = new JwksKeyStore({ url: URL, fetchJson });

    const found = await Promise.all([1, 2, 3].map(() => keys.key(CORE_KEY.kid)));

    expect(found.every(Boolean)).toBe(true);
    expect(state.fetches).toBe(1);
  });

  it('fetches it again once it is older than the TTL, which retires old keys', async () => {
    const { state, fetchJson } = core();
    const { time, now } = clock();
    const keys = new JwksKeyStore({ url: URL, fetchJson, now, ttlMs: 600_000 });
    await keys.key(CORE_KEY.kid);

    const current = signingKey('core-key-2');
    state.keys = [jwkOf(current)];
    time.now += 599_999;
    expect(await keys.key(CORE_KEY.kid)).toBeDefined();
    expect(state.fetches).toBe(1);

    time.now += 1;
    expect(await keys.key(current.kid)).toBeDefined();
    expect(state.fetches).toBe(2);
    // The retired key is gone (and asking for it right away doesn't fetch again)
    expect(await keys.key(CORE_KEY.kid)).toBeUndefined();
    expect(state.fetches).toBe(2);
  });

  it('fetches again for an unknown kid at most once per interval', async () => {
    const { state, fetchJson } = core();
    const { time, now } = clock();
    const keys = new JwksKeyStore({ url: URL, fetchJson, now, minRefreshMs: 30_000 });
    await keys.key(CORE_KEY.kid);

    time.now += 30_000;
    expect(await keys.key('made-up-1')).toBeUndefined();
    expect(await keys.key('made-up-2')).toBeUndefined();
    expect(await keys.key('made-up-3')).toBeUndefined();

    expect(state.fetches).toBe(2);
  });

  it('finds a key that faclab-core started publishing', async () => {
    const { state, fetchJson } = core();
    const { time, now } = clock();
    const keys = new JwksKeyStore({ url: URL, fetchJson, now, minRefreshMs: 30_000 });
    await keys.key(CORE_KEY.kid);

    const next = signingKey('core-key-2');
    state.keys = [jwkOf(next), jwkOf(CORE_KEY)];
    time.now += 30_000;

    expect(await keys.key(next.kid)).toBeDefined();
    expect(await keys.key(CORE_KEY.kid)).toBeDefined();
  });

  it('keeps the keys it has while faclab-core does not answer', async () => {
    const { state, fetchJson } = core();
    const { time, now } = clock();
    const keys = new JwksKeyStore({ url: URL, fetchJson, now, ttlMs: 1_000, minRefreshMs: 500 });
    await keys.key(CORE_KEY.kid);

    state.down = true;
    time.now += 1_000;
    expect(await keys.key(CORE_KEY.kid)).toBeDefined();
    // Not on every request: once per interval
    expect(await keys.key(CORE_KEY.kid)).toBeDefined();
    expect(state.fetches).toBe(2);

    state.down = false;
    time.now += 500;
    expect(await keys.key(CORE_KEY.kid)).toBeDefined();
    expect(state.fetches).toBe(3);
  });

  it('answers 503 AUTH_UNAVAILABLE while it has never read the keys', async () => {
    const { state, fetchJson } = core();
    const { time, now } = clock();
    state.down = true;
    const keys = new JwksKeyStore({ url: URL, fetchJson, now, minRefreshMs: 30_000 });

    await expect(keys.key(CORE_KEY.kid)).rejects.toBeInstanceOf(AuthUnavailableError);
    await expect(keys.key(CORE_KEY.kid)).rejects.toMatchObject({
      statusCode: 503,
      code: 'AUTH_UNAVAILABLE',
    });
    expect(state.fetches).toBe(1);

    state.down = false;
    time.now += 30_000;
    expect(await keys.key(CORE_KEY.kid)).toBeDefined();
  });
});

describe('parseJwks', () => {
  it('keeps only the Ed25519 signing keys', () => {
    const good = jwkOf(CORE_KEY);
    const keys = parseJwks({
      keys: [
        good,
        { ...good, kid: 'for-encryption', use: 'enc' },
        { ...good, kid: 'other-alg', alg: 'RS256' },
        { kty: 'RSA', kid: 'rsa', n: 'AQAB', e: 'AQAB' },
        { ...good, kid: undefined },
        { ...good, kid: 'broken', x: 'not-a-key' },
        null,
      ],
    });

    expect([...keys.keys()]).toEqual([CORE_KEY.kid]);
  });

  it('refuses a body without keys', () => {
    expect(() => parseJwks({ nope: [] })).toThrow('the JWKS has no keys');
    expect(() => parseJwks(null)).toThrow('the JWKS has no keys');
  });
});
