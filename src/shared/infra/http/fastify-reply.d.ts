import 'fastify';

import type { RequestAuth } from './auth';

declare module 'fastify' {
  interface FastifyReply {
    /** `{ data, meta }`; `extraMeta` adds to the meta, like `pagination` in lists */
    success(data: unknown, extraMeta?: Record<string, unknown>): FastifyReply;
  }

  interface FastifyRequest {
    /** The caller and its company; null on routes without `authorize` */
    auth: RequestAuth | null;
  }
}
