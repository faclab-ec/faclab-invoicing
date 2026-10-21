import { FastifyInstance } from 'fastify';

import { AppError, BadRequestError, NotFoundError } from '#/shared/errors/app-error';
import { Authorize, tenantOf } from '#/shared/infra/http/auth';
import { logger } from '#/shared/logger';

import {
  GetCompanyConfigQuery,
  SaveCompanyConfigCommand,
  SaveCompanyConfigInput,
} from '../../app/company-config.commands';
import { ListSequencesQuery, SetNextSequenceCommand } from '../../app/sequence.commands';
import { toResponse, toSequenceResponse } from './company-config.mapper';
import {
  getCompanyConfigSchema,
  listSequencesSchema,
  saveCompanyConfigSchema,
  setNextSequenceSchema,
} from './company-config.schemas';

export interface CompanyConfigHandlers {
  save: SaveCompanyConfigCommand;
  get: GetCompanyConfigQuery;
  listSequences: ListSequencesQuery;
  setNextSequence: SetNextSequenceCommand;
}

export function registerCompanyConfigRoutes(
  app: FastifyInstance,
  handlers: CompanyConfigHandlers,
  authorize: Authorize,
): void {
  // Company settings: same permission as in faclab-web. Always the caller's company
  const preHandler = authorize('user:manage');

  // PUT /api/company-config — create or update
  app.put(
    '/api/company-config',
    { schema: saveCompanyConfigSchema, preHandler },
    async (request, reply) => {
      try {
        const config = await handlers.save.execute(
          tenantOf(request),
          request.body as SaveCompanyConfigInput,
        );
        logger.info('Company config saved');
        return reply.success(toResponse(config));
      } catch (error) {
        if (error instanceof AppError) throw error;
        logger.error({ error }, 'Failed to save company config');
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new BadRequestError(message);
      }
    },
  );

  // GET /api/company-config — get current config
  app.get(
    '/api/company-config',
    { schema: getCompanyConfigSchema, preHandler },
    async (request, reply) => {
      const config = await handlers.get.execute(tenantOf(request));
      if (!config) {
        throw new NotFoundError('Company config not found');
      }
      return reply.success(toResponse(config));
    },
  );

  // GET /api/sequences — the company's invoice counters
  app.get('/api/sequences', { schema: listSequencesSchema, preHandler }, async (request, reply) => {
    const sequences = await handlers.listSequences.execute(tenantOf(request));
    return reply.success(sequences.map(toSequenceResponse));
  });

  // PUT /api/sequences/:establishment/:emissionPoint — where its numbering continues
  app.put<{
    Params: { establishment: string; emissionPoint: string };
    Body: { nextSequence: number };
  }>(
    '/api/sequences/:establishment/:emissionPoint',
    { schema: setNextSequenceSchema, preHandler },
    async (request, reply) => {
      const sequence = await handlers.setNextSequence.execute(tenantOf(request), {
        establishment: request.params.establishment,
        emissionPoint: request.params.emissionPoint,
        nextSequence: request.body.nextSequence,
      });
      logger.info(
        { establishment: sequence.establishment, emissionPoint: sequence.emissionPoint },
        'Invoice sequence set',
      );
      return reply.success(toSequenceResponse(sequence));
    },
  );
}
