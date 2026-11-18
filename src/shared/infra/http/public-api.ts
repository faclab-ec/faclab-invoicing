import { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';

import { AppError } from '#/shared/errors/app-error';

// The public API of this service (S6.3): `/api/v1`, for integration clients of faclab-core.
// Its contract is the OpenAPI of these routes only (`publicOpenapi`), kept in
// docs/public-api/openapi-v1.json and compared by the CI with the base branch's

export const PUBLIC_API_PREFIX = '/api/v1';

export class PublicApiDisabledError extends AppError {
  readonly statusCode = 503;
  readonly code = 'PUBLIC_API_DISABLED';
}

/** PUBLIC_API_ENABLED=false turns every public route off: the rollback switch */
export const publicApiEnabled =
  (enabled: boolean): preHandlerAsyncHookHandler =>
  async () => {
    if (!enabled) throw new PublicApiDisabledError('The public API is disabled');
  };

/** The OAuth 2.0 scheme of faclab-core's integration clients, which issues their tokens */
export const clientCredentialsScheme = {
  type: 'oauth2',
  description:
    "faclab-core's OAuth 2.0 client credentials (`POST /api/oauth/token` of the same domain)",
  flows: {
    clientCredentials: {
      tokenUrl: '/api/oauth/token',
      scopes: { 'invoices:read': 'Read invoices and credit notes, their XML and RIDE' },
    },
  },
} as const;

/** The OpenAPI of the public routes only, once the app is ready */
export function publicOpenapi(app: FastifyInstance): Record<string, unknown> {
  const spec = app.swagger() as {
    paths?: Record<string, unknown>;
    components?: Record<string, unknown>;
  };
  const paths = Object.fromEntries(
    Object.entries(spec.paths ?? {}).filter(([path]) => path.startsWith(PUBLIC_API_PREFIX)),
  );
  return {
    // Its schemas use JSON Schema's type lists for nullable values
    openapi: '3.1.0',
    info: {
      title: 'Faclab API — invoices',
      version: '1.0.0',
      description:
        "The electronic documents of faclab-core's public API (`/api/v1/invoices`), served by faclab-invoicing behind the same domain and token. Same conventions: camelCase JSON, money as decimal strings, `{data, meta}` and `{errors, meta}`, stable order with `sort` and `updatedSince`, rate limits with `RateLimit-*` headers and 429 `RATE_LIMITED` with `Retry-After`.",
    },
    tags: [{ name: 'Invoices', description: 'Invoices and credit notes of the sales.' }],
    paths,
    components: { securitySchemes: { clientCredentials: clientCredentialsScheme } },
  };
}

/** How the snapshot is written: stable and readable in a diff */
export const renderOpenapi = (spec: Record<string, unknown>) =>
  `${JSON.stringify(spec, null, 2)}\n`;
