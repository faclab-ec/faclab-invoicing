import { createPublicKey, KeyObject } from 'crypto';

import { AppError } from '#/shared/errors/app-error';
import { logger } from '#/shared/logger';

// faclab-core's public keys (S6.1), read from its /.well-known/jwks.json and kept in memory.
// The set is fetched again once it is older than `ttlMs`, and also when a token names a key it
// doesn't have (a new key after a rotation), at most once every `minRefreshMs` so tokens with
// made-up `kid`s can't make every request call faclab-core.

/** Gives the public key of a `kid`, or undefined when faclab-core doesn't publish it */
export interface KeyStore {
  key(kid: string): Promise<KeyObject | undefined>;
}

/** faclab-core's keys can't be read: the token can't be checked either way */
export class AuthUnavailableError extends AppError {
  readonly statusCode = 503;
  readonly code = 'AUTH_UNAVAILABLE';
}

export type FetchJson = (url: string, timeoutMs: number) => Promise<unknown>;

export interface JwksKeyStoreOptions {
  url: string;
  fetchJson?: FetchJson;
  now?: () => number;
  ttlMs?: number;
  minRefreshMs?: number;
  timeoutMs?: number;
}

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MIN_REFRESH_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`JWKS answered ${response.status}`);
  return response.json();
}

/** The Ed25519 signing keys of a JWK set (RFC 7517) by `kid`; anything else is ignored */
export function parseJwks(body: unknown): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  const entries = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(entries)) throw new Error('the JWKS has no keys');
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const jwk = entry as Record<string, unknown>;
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') continue;
    if (typeof jwk.kid !== 'string' || (jwk.use !== undefined && jwk.use !== 'sig')) continue;
    if (jwk.alg !== undefined && jwk.alg !== 'EdDSA') continue;
    try {
      keys.set(
        jwk.kid,
        createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' }),
      );
    } catch {
      // a malformed key can't verify anything
    }
  }
  return keys;
}

export class JwksKeyStore implements KeyStore {
  private keys: Map<string, KeyObject> | null = null;
  private loadedAt = 0;
  private attemptedAt = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<void> | null = null;

  private readonly fetchJson: FetchJson;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly minRefreshMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: JwksKeyStoreOptions) {
    this.fetchJson = options.fetchJson ?? fetchJson;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.minRefreshMs = options.minRefreshMs ?? DEFAULT_MIN_REFRESH_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async key(kid: string): Promise<KeyObject | undefined> {
    if (this.keys === null || this.now() - this.loadedAt >= this.ttlMs) {
      await this.refresh();
    }
    let key = this.keys?.get(kid);
    if (!key && this.keys !== null) {
      // Maybe faclab-core started signing with a new key
      await this.refresh();
      key = this.keys?.get(kid);
    }
    if (this.keys === null) {
      throw new AuthUnavailableError("faclab-core's signing keys can't be read");
    }
    return key;
  }

  /** Fetches the set again unless another request is already doing it (then waits for it) or
   * the last attempt was less than `minRefreshMs` ago, so a down faclab-core isn't called on
   * every request */
  private refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.now() - this.attemptedAt < this.minRefreshMs) return Promise.resolve();
    this.inFlight = this.load().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async load(): Promise<void> {
    this.attemptedAt = this.now();
    try {
      this.keys = parseJwks(await this.fetchJson(this.options.url, this.timeoutMs));
      this.loadedAt = this.now();
    } catch (error) {
      // The keys already read keep working while faclab-core can't answer
      logger.warn(
        { err: error, url: this.options.url, cachedKeys: this.keys?.size ?? 0 },
        'JWKS refresh failed',
      );
    }
  }
}
