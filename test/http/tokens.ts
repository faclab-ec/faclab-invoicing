import { generateKeyPairSync, KeyObject, sign } from 'crypto';

import { AuthConfig } from '#/shared/infra/http/auth';
import { KeyStore } from '#/shared/infra/http/jwks';

/** An Ed25519 key of faclab-core and the `kid` it publishes it with */
export interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export function signingKey(kid: string): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { kid, privateKey, publicKey };
}

/** The key faclab-core signs with in these tests */
export const CORE_KEY = signingKey('core-key-1');

/** The public JWK of a key, as faclab-core's /.well-known/jwks.json lists it */
export const jwkOf = (key: SigningKey) => ({
  ...key.publicKey.export({ format: 'jwk' }),
  kid: key.kid,
  alg: 'EdDSA',
  use: 'sig',
});

/** A key store that knows these keys, without fetching a JWKS */
export const publishedKeys = (...keys: SigningKey[]): KeyStore => ({
  key: async (kid) => keys.find((key) => key.kid === kid)?.publicKey,
});

export const AUTH: AuthConfig = {
  issuer: 'faclab-core',
  audience: 'faclab-invoicing',
  keys: publishedKeys(CORE_KEY),
};

const PERMISSIONS = ['sale:read', 'sale:write', 'user:manage'];

const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** An access token as faclab-core signs it (EdDSA, its key's `kid` in the header) */
export function accessToken(
  claims: Record<string, unknown>,
  { key = CORE_KEY, header = {} }: { key?: SigningKey; header?: Record<string, unknown> } = {},
): string {
  const head = segment({ alg: 'EdDSA', typ: 'JWT', kid: key.kid, ...header });
  const payload = segment({
    sub: '7',
    username: 'admin',
    perms: PERMISSIONS,
    typ: 'access',
    iss: AUTH.issuer,
    aud: ['faclab-core', 'faclab-invoicing'],
    exp: Math.floor(Date.now() / 1000) + 900,
    ...claims,
  });
  const signature = sign(null, Buffer.from(`${head}.${payload}`), key.privateKey);
  return `${head}.${payload}.${signature.toString('base64url')}`;
}

/** The Authorization header of a user of the company `tid` */
export const bearer = (tid: string) => ({ authorization: `Bearer ${accessToken({ tid })}` });
