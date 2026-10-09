import { FastifyInstance } from 'fastify';

import { BadRequestError, NotFoundError, ValidationError } from '#/shared/errors/app-error';
import { Authorize } from '#/shared/infra/http/auth';
import { logger } from '#/shared/logger';

import {
  DeleteCertificateCommand,
  GetCertificateCommand,
  ListCertificatesCommand,
  UploadCertificateCommand,
} from '../../app/certificate.commands';
import { toResponse } from './certificate.mapper';
import {
  deleteCertificateSchema,
  getCertificateSchema,
  listCertificatesSchema,
  uploadCertificateSchema,
} from './certificate.schemas';

export interface CertificateCommands {
  upload: UploadCertificateCommand;
  get: GetCertificateCommand;
  list: ListCertificatesCommand;
  delete: DeleteCertificateCommand;
}

export function registerCertificateRoutes(
  app: FastifyInstance,
  commands: CertificateCommands,
  authorize: Authorize,
): void {
  // Signing certificates are company settings: same permission as in faclab-web
  const preHandler = authorize('user:manage');

  // POST /api/certificates — upload .p12
  app.post(
    '/api/certificates',
    { schema: uploadCertificateSchema, preHandler },
    async (request, reply) => {
      const data = await request.file();
      if (!data) {
        throw new BadRequestError('No file uploaded');
      }

      if (!data.filename.endsWith('.p12')) {
        throw new BadRequestError('Only .p12 files are accepted');
      }

      const chunks: Buffer[] = [];
      for await (const chunk of data.file) {
        chunks.push(chunk);
      }
      const fileBuffer = Buffer.concat(chunks);

      const passwordField = data.fields['password'];
      const password =
        passwordField && 'value' in passwordField ? (passwordField.value as string) : '';

      try {
        const certificate = await commands.upload.execute({
          fileBuffer,
          fileName: data.filename,
          password,
        });

        logger.info({ certificateId: certificate.id }, 'Certificate uploaded');
        reply.code(201);
        return reply.success(toResponse(certificate));
      } catch (error) {
        logger.error({ error }, 'Failed to upload certificate');
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new ValidationError(message);
      }
    },
  );

  // GET /api/certificates — list all
  app.get(
    '/api/certificates',
    { schema: listCertificatesSchema, preHandler },
    async (_request, reply) => {
      const certificates = await commands.list.execute();
      return reply.success(certificates.map(toResponse));
    },
  );

  // GET /api/certificates/:id — get by ID
  app.get<{ Params: { id: string } }>(
    '/api/certificates/:id',
    { schema: getCertificateSchema, preHandler },
    async (request, reply) => {
      const certificate = await commands.get.execute(request.params.id);
      if (!certificate) {
        throw new NotFoundError('Certificate not found');
      }
      return reply.success(toResponse(certificate));
    },
  );

  // DELETE /api/certificates/:id — delete
  app.delete<{ Params: { id: string } }>(
    '/api/certificates/:id',
    { schema: deleteCertificateSchema, preHandler },
    async (request, reply) => {
      await commands.delete.execute(request.params.id);
      return reply.code(204).send();
    },
  );
}
