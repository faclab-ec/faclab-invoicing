import { verify } from 'crypto';
import { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';

import { AppError } from '#/shared/errors/app-error';

import { KeyStore } from './jwks';

// Access tokens are issued by faclab-core, signed with its Ed25519 key (EdDSA, S6.1) and
// checked here with the public keys it publishes (`keys`): this service can't issue one.
// The error codes match faclab-core's, so faclab-web reacts the same way (refresh on
// TOKEN_EXPIRED, sign out on INVALID_TOKEN, etc.). Their `tid` is the company the request
// acts for: every route reads and writes only its data.

export interface AuthConfig {
  // faclab-core's JWT_ISSUER
  issuer: string;
  // This service's name, which the token's `aud` must list
  audience: string;
  keys: KeyStore;
}

/** An integration client of faclab-core (S6.2): a system of the company, with scopes */
export interface IntegrationClaims {
  // Its OAuth client_id (`azp`): fl_live_… or fl_test_…
  clientId: string;
  scopes: string[];
  // The branches of faclab-core it may see; null, every one (`bids`)
  branchIds: number[] | null;
}

export interface AccessClaims {
  userId: string;
  username: string;
  // The company (faclab-core tenant) the token was issued for
  tenantId: string;
  permissions: string[];
  mustChangePassword: boolean;
  // An integration client's token (S6.3): scopes instead of permissions; null for a person
  integration: IntegrationClaims | null;
}

/** Who calls and for which company; set by `authorize` on every protected route */
export type RequestAuth = Omit<AccessClaims, 'mustChangePassword'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

const ED25519_SIGNATURE_BYTES = 64;

const listsAudience = (aud: unknown, audience: string) =>
  aud === audience || (Array.isArray(aud) && aud.includes(audience));

// faclab-core's subject of an integration client's token: `client:<client_id>`
const CLIENT_SUBJECT_PREFIX = 'client:';

function integrationOf(payload: Record<string, unknown>): IntegrationClaims | null {
  if (typeof payload.sub !== 'string' || !payload.sub.startsWith(CLIENT_SUBJECT_PREFIX)) {
    return null;
  }
  if (typeof payload.azp !== 'string') throw invalidToken('missing azp');
  const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [];
  const branchIds = Array.isArray(payload.bids)
    ? payload.bids.filter((id): id is number => Number.isInteger(id))
    : null;
  return { clientId: payload.azp, scopes, branchIds };
}

export async function verifyAccessToken(
  token: string,
  { issuer, audience, keys }: AuthConfig,
  now: number = Date.now(),
): Promise<AccessClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw invalidToken('malformed');
  const [headerSegment, payloadSegment, signatureSegment] = parts;

  // Only EdDSA: a token that picks another algorithm (HS256 keyed with the public key, none)
  // is refused before any key is looked at
  const header = decodeSegment(headerSegment);
  if (header.alg !== 'EdDSA') throw invalidToken('unsupported algorithm');
  if (typeof header.kid !== 'string') throw invalidToken('missing kid');

  const key = await keys.key(header.kid);
  if (!key) throw invalidToken('unknown key');
  const signature = Buffer.from(signatureSegment, 'base64url');
  const signed = Buffer.from(`${headerSegment}.${payloadSegment}`);
  if (signature.length !== ED25519_SIGNATURE_BYTES || !verify(null, signed, key, signature)) {
    throw invalidToken('bad signature');
  }

  const payload = decodeSegment(payloadSegment);
  if (typeof payload.exp !== 'number') throw invalidToken('missing exp');
  if (payload.exp * 1000 <= now) {
    throw new AuthError(401, 'TOKEN_EXPIRED', 'access token expired');
  }
  if (payload.iss !== issuer) throw invalidToken('wrong issuer');
  // A token faclab-core issued only for itself (a refresh token) isn't good here
  if (!listsAudience(payload.aud, audience)) throw invalidToken('wrong audience');
  if (payload.typ !== 'access') throw invalidToken('not an access token');
  // Same answer as faclab-core for a token from before companies existed
  if (typeof payload.tid !== 'string' || !UUID.test(payload.tid)) {
    throw new AuthError(401, 'TENANT_REQUIRED', 'the access token has no company (tid)');
  }

  const integration = integrationOf(payload);
  // An integration never carries permissions: only the scopes of its client
  const permissions =
    !integration && Array.isArray(payload.perms)
      ? payload.perms.filter((p): p is string => typeof p === 'string')
      : [];
  return {
    userId: String(payload.sub),
    username: integration
      ? integration.clientId
      : typeof payload.username === 'string'
        ? payload.username
        : '',
    tenantId: payload.tid.toLowerCase(),
    permissions,
    mustChangePassword: payload.mcp === true,
    integration,
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

    const claims = await verifyAccessToken(token, config);
    // The internal API is faclab-web's contract: integrations use /api/v1 (S6.3)
    if (claims.integration) {
      throw new AuthError(
        403,
        'INTEGRATION_NOT_ALLOWED',
        'integration credentials only work on the public API (/api/v1)',
      );
    }
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
    request.auth = {
      userId: claims.userId,
      username: claims.username,
      tenantId: claims.tenantId,
      permissions: claims.permissions,
      integration: null,
    };
  };
}

/** preHandler of the public API: an integration client's token with `scope` (S6.3) */
export type RequireScope = (scope: string) => preHandlerAsyncHookHandler;

export function createRequireScope(config: AuthConfig): RequireScope {
  return (scope) => async (request) => {
    const token = bearerToken(request);
    if (!token) throw new AuthError(403, 'PERMISSION_DENIED', 'authentication required');

    const claims = await verifyAccessToken(token, config);
    if (!claims.integration) {
      throw new AuthError(403, 'PERMISSION_DENIED', 'this route takes integration credentials');
    }
    if (!claims.integration.scopes.includes(scope)) {
      throw new AuthError(403, 'INSUFFICIENT_SCOPE', `missing scopes: ['${scope}']`);
    }
    request.auth = {
      userId: claims.userId,
      username: claims.username,
      tenantId: claims.tenantId,
      permissions: [],
      integration: claims.integration,
    };
  };
}

/** The integration client of a request of the public API */
export function integrationOfRequest(request: FastifyRequest): IntegrationClaims {
  const integration = request.auth?.integration;
  if (!integration) {
    throw new AuthError(403, 'PERMISSION_DENIED', 'this route takes integration credentials');
  }
  return integration;
}

/** The company of the request; only on routes behind `authorize` */
export function tenantOf(request: FastifyRequest): string {
  if (!request.auth) throw new AuthError(403, 'PERMISSION_DENIED', 'authentication required');
  return request.auth.tenantId;
}
