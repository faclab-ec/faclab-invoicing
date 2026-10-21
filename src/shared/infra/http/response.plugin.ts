import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { AppError } from '#/shared/errors/app-error';
import { logger } from '#/shared/logger';

function buildMeta(request: FastifyRequest): { requestId: string; timestamp: string } {
  return {
    requestId: request.id as string,
    timestamp: new Date().toISOString(),
  };
}

async function responsePlugin(app: FastifyInstance): Promise<void> {
  app.decorateReply(
    'success',
    function (this: FastifyReply, data: unknown, extraMeta: Record<string, unknown> = {}) {
      const meta = { ...buildMeta(this.request), ...extraMeta };
      return this.send({ data, meta });
    },
  );

  app.setErrorHandler(
    (error: Error & { statusCode?: number; validation?: unknown }, request, reply) => {
      const meta = buildMeta(request);

      if (error instanceof AppError) {
        return reply.status(error.statusCode).send({
          errors: [{ code: error.code, message: error.message }],
          meta,
        });
      }

      // Fastify schema validation errors carry a `validation` array
      if (error.validation !== undefined) {
        return reply.status(400).send({
          errors: [{ code: 'VALIDATION_ERROR', message: error.message }],
          meta,
        });
      }

      // Unknown errors — log and return 500
      logger.error({ err: error }, 'Unhandled error');
      return reply.status(500).send({
        errors: [{ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' }],
        meta,
      });
    },
  );
}

// fp ensures the plugin is not scoped — decorators and error handler apply to the whole app
export default fp(responsePlugin, { name: 'response-plugin' });
