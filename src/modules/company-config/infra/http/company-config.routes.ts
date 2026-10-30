import { FastifyInstance } from 'fastify';

import {
  AppError,
  BadRequestError,
  NotFoundError,
  storageUnavailable,
} from '#/shared/errors/app-error';
import { Authorize, tenantOf } from '#/shared/infra/http/auth';
import { logger } from '#/shared/logger';

import {
  GetCompanyConfigQuery,
  SaveCompanyConfigCommand,
  SaveCompanyConfigInput,
} from '../../app/company-config.commands';
import {
  DeleteIssuerLogoCommand,
  GetIssuerLogoQuery,
  logoTooLarge,
  SetIssuerLogoCommand,
} from '../../app/issuer-logo.commands';
import { ListSequencesQuery, SetNextSequenceCommand } from '../../app/sequence.commands';
import { LOGO_MAX_BYTES } from '../../domain/logo';
import { toResponse, toSequenceResponse } from './company-config.mapper';
import {
  deleteLogoSchema,
  getCompanyConfigSchema,
  getLogoSchema,
  listSequencesSchema,
  saveCompanyConfigSchema,
  setNextSequenceSchema,
  uploadLogoSchema,
} from './company-config.schemas';

export interface CompanyConfigHandlers {
  save: SaveCompanyConfigCommand;
  get: GetCompanyConfigQuery;
  listSequences: ListSequencesQuery;
  setNextSequence: SetNextSequenceCommand;
  setLogo: SetIssuerLogoCommand;
  deleteLogo: DeleteIssuerLogoCommand;
  getLogo: GetIssuerLogoQuery;
}

/** What the object storage throws becomes 503: the domain's own errors keep their code */
async function withStorage<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error({ err: error }, 'The document storage failed');
    throw storageUnavailable();
  }
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

  // PUT /api/company-config/logo — the logo of its RIDEs (multipart, field `file`)
  app.put(
    '/api/company-config/logo',
    { schema: uploadLogoSchema, preHandler },
    async (request, reply) => {
      let bytes: Buffer;
      try {
        const data = await request.file({ limits: { fileSize: LOGO_MAX_BYTES, files: 1 } });
        if (!data) throw new BadRequestError('No file uploaded');
        bytes = await data.toBuffer();
      } catch (error) {
        if (error instanceof AppError) throw error;
        // @fastify/multipart's own errors aren't AppErrors: they would answer 500
        if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw logoTooLarge();
        throw new BadRequestError('Send the logo as multipart/form-data in the field `file`');
      }
      const config = await withStorage(() => handlers.setLogo.execute(tenantOf(request), bytes));
      logger.info('Issuer logo saved');
      return reply.success(toResponse(config));
    },
  );

  // DELETE /api/company-config/logo — its RIDEs go out without a logo
  app.delete(
    '/api/company-config/logo',
    { schema: deleteLogoSchema, preHandler },
    async (request, reply) => {
      await handlers.deleteLogo.execute(tenantOf(request));
      logger.info('Issuer logo removed');
      return reply.code(204).send();
    },
  );

  // GET /api/company-config/logo — the logo as it was uploaded
  app.get(
    '/api/company-config/logo',
    { schema: getLogoSchema, preHandler },
    async (request, reply) => {
      const logo = await withStorage(() => handlers.getLogo.execute(tenantOf(request)));
      if (!logo) throw new NotFoundError('The company has no logo');
      return reply
        .header('Content-Type', logo.contentType)
        .header('Cache-Control', 'private, no-cache')
        .send(logo.bytes);
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
