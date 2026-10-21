import 'fastify';

declare module 'fastify' {
  interface FastifyReply {
    /** `{ data, meta }`; `extraMeta` adds to the meta, like `pagination` in lists */
    success(data: unknown, extraMeta?: Record<string, unknown>): FastifyReply;
  }
}
