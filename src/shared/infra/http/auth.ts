import { createHmac, timingSafeEqual } from 'crypto';
import { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';

import { AppError } from '#/shared/errors/app-error';

// Access tokens are issued by faclab-core (HS256, shared JWT_SECRET). The
// error codes match faclab-core's, so faclab-web reacts the same way
// (refresh on TOKEN_EXPIRED, sign out on INVALID_TOKEN, etc.).

export interface AuthConfig {
  jwtSecret: string;
  jwtIssuer: string;
}

export interface AccessClaims {
  userId: string;
  username: string;
  permissions: string[];
  mustChangePassword: boolean;
}

export class AuthError extends AppError {
  constructor(
    readonly statusCode: 401 | 403,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const invalidToken = (reason: string) =>
  new AuthError(401, 'INVALID_TOKEN', `invalid token: ${reason}`);

function decodeSegment(segment: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    if (value && typeof value === 'object') return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw invalidToken('malformed');
}

export function verifyAccessToken(
  token: string,
  { jwtSecret, jwtIssuer }: AuthConfig,
  now: number = Date.now(),
): AccessClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw invalidToken('malformed');
  const [headerSegment, payloadSegment, signatureSegment] = parts;

  if (decodeSegment(headerSegment).alg !== 'HS256') throw invalidToken('unsupported algorithm');

  const expected = createHmac('sha256', jwtSecret)
    .update(`${headerSegment}.${payloadSegment}`)
    .digest();
  const signature = Buffer.from(signatureSegment, 'base64url');
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
    throw invalidToken('bad signature');
  }

  const payload = decodeSegment(payloadSegment);
  if (typeof payload.exp !== 'number') throw invalidToken('missing exp');
  if (payload.exp * 1000 <= now) {
    throw new AuthError(401, 'TOKEN_EXPIRED', 'access token expired');
  }
  if (payload.iss !== jwtIssuer) throw invalidToken('wrong issuer');
  if (payload.typ !== 'access') throw invalidToken('not an access token');

  const permissions = Array.isArray(payload.perms)
    ? payload.perms.filter((p): p is string => typeof p === 'string')
    : [];
  return {
    userId: String(payload.sub),
    username: typeof payload.username === 'string' ? payload.username : '',
    permissions,
    mustChangePassword: payload.mcp === true,
  };
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header || !header.toLowerCase().startsWith('bearer ')) return null;
  return header.slice('bearer '.length).trim();
}

/** preHandler that lets the request through only with `permission` */
export type Authorize = (permission: string) => preHandlerAsyncHookHandler;

export function createAuthorize(config: AuthConfig): Authorize {
  return (permission) => async (request) => {
    const token = bearerToken(request);
    if (!token) throw new AuthError(403, 'PERMISSION_DENIED', 'authentication required');

    const claims = verifyAccessToken(token, config);
    if (claims.mustChangePassword) {
      throw new AuthError(
        403,
        'PASSWORD_CHANGE_REQUIRED',
        'password change required before any other action',
      );
    }
    if (!claims.permissions.includes(permission)) {
      throw new AuthError(403, 'PERMISSION_DENIED', `missing permissions: ['${permission}']`);
    }
  };
}
