import fastifyCors from '@fastify/cors';
import fastifyMultipart from '@fastify/multipart';
import { FastifyOtelInstrumentation } from '@fastify/otel';
import fastifySwagger from '@fastify/swagger';
import scalarFastify from '@scalar/fastify-api-reference';
import { randomUUID } from 'crypto';
import Fastify, { FastifyInstance } from 'fastify';

import { logger } from '../logger';
import responsePlugin from './http/response.plugin';

export interface HttpServerConfig {
  port: number;
  host: string;
  corsOrigins: string[];
  serviceName: string;
  serviceVersion: string;
}

export async function createHttpServer(config: HttpServerConfig): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: logger,
    genReqId: (req) => (req.headers['x-request-id'] as string) ?? randomUUID(),
  });

  const otelPlugin = new FastifyOtelInstrumentation().plugin();
  await app.register(otelPlugin);

  await app.register(fastifyCors, {
    origin: config.corsOrigins,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await app.register(responsePlugin);
  // Filled in by `authorize` (http/auth.ts)
  app.decorateRequest('auth', null);

  await app.register(fastifyMultipart, {
    limits: { fileSize: 10 * 1024 * 1024 },
    attachFieldsToBody: false,
  });

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: config.serviceName,
        version: config.serviceVersion,
        description: 'Faclab Invoicing API',
      },
    },
    transform: ({ schema, url, ...rest }) => {
      const { multipartBody, ...schemaRest } = schema as Record<string, unknown>;
      const transformed = { ...schemaRest };
      if (multipartBody) {
        transformed.body = {
          content: {
            'multipart/form-data': {
              schema: multipartBody,
            },
          },
        };
      }
      return { schema: transformed, url, ...rest };
    },
  });

  await app.register(scalarFastify, { routePrefix: '/docs' });

  app.get(
    '/health',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: { status: { type: 'string' } },
          },
        },
      },
    },
    async () => ({ status: 'ok' }),
  );

  return app as unknown as FastifyInstance;
}
