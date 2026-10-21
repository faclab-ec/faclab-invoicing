import { createHmac } from 'crypto';

export const AUTH = { jwtSecret: 'test-secret-of-faclab-core', jwtIssuer: 'faclab-core' };

const PERMISSIONS = ['sale:read', 'sale:write', 'user:manage'];

const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** An access token as faclab-core signs it (HS256) */
export function accessToken(claims: Record<string, unknown>): string {
  const header = segment({ alg: 'HS256', typ: 'JWT' });
  const payload = segment({
    sub: '7',
    username: 'admin',
    perms: PERMISSIONS,
    typ: 'access',
    iss: AUTH.jwtIssuer,
    exp: Math.floor(Date.now() / 1000) + 900,
    ...claims,
  });
  const signature = createHmac('sha256', AUTH.jwtSecret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/** The Authorization header of a user of the company `tid` */
export const bearer = (tid: string) => ({ authorization: `Bearer ${accessToken({ tid })}` });
