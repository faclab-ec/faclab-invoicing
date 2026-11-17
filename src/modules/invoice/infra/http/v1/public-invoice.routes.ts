import { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';

import { NotFoundError } from '#/shared/errors/app-error';
import { AuthError, integrationOfRequest, RequireScope, tenantOf } from '#/shared/infra/http/auth';
import { withStorage } from '#/shared/infra/http/storage';

import { GetAuthorizedXmlQuery, GetRideQuery } from '../../../app/queries/invoice.queries';
import {
  BranchScope,
  GetPublicInvoiceQuery,
  ListPublicInvoicesQuery,
  PublicInvoiceOptions,
} from '../../../app/queries/public-invoice.queries';
import { toPublicDocument } from './public-invoice.mapper';
import {
  getPublicInvoiceSchema,
  getPublicRideSchema,
  getPublicXmlSchema,
  listPublicInvoicesSchema,
} from './public-invoice.schemas';

export interface PublicInvoiceHandlers {
  list: ListPublicInvoicesQuery;
  get: GetPublicInvoiceQuery;
  authorizedXml: GetAuthorizedXmlQuery;
  ride: GetRideQuery;
}

export interface PublicApiGuards {
  // PUBLIC_API_ENABLED=false answers 503 PUBLIC_API_DISABLED (the rollback switch)
  enabled: preHandlerAsyncHookHandler;
  requireScope: RequireScope;
  rateLimit: preHandlerAsyncHookHandler;
}

const SCOPE = 'invoices:read';

/**
 * The public API of the electronic documents (S6.3): `/api/v1/invoices`, for integration clients
 * with `invoices:read`, behind the same domain as faclab-core's `/api/v1` (Caddy routes it here).
 */
export function registerPublicInvoiceRoutes(
  app: FastifyInstance,
  handlers: PublicInvoiceHandlers,
  guards: PublicApiGuards,
): void {
  const preHandler = [guards.enabled, guards.requireScope(SCOPE), guards.rateLimit];
  const scope = (request: Parameters<typeof integrationOfRequest>[0]): BranchScope =>
    integrationOfRequest(request).branchIds;

  // The document of a branch the client may see, or 404
  const visible = async (request: Parameters<typeof tenantOf>[0], id: string) => {
    const invoice = await handlers.get.execute(tenantOf(request), scope(request), id);
    if (!invoice) throw new NotFoundError('Invoice not found');
    return invoice;
  };

  app.get<{ Querystring: PublicInvoiceOptions }>(
    '/api/v1/invoices',
    { schema: listPublicInvoicesSchema, preHandler },
    async (request, reply) => {
      const branches = scope(request);
      const { branchId, limit, offset } = request.query;
      if (branchId !== undefined && branches !== null && !branches.includes(branchId)) {
        throw new AuthError(403, 'BRANCH_ACCESS_DENIED', 'this client may not see this branch');
      }
      const page = await handlers.list.execute(tenantOf(request), branches, request.query);
      return reply.success(page.items.map(toPublicDocument), {
        pagination: { total: page.total, limit, offset },
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/invoices/:id',
    { schema: getPublicInvoiceSchema, preHandler },
    async (request, reply) =>
      reply.success(toPublicDocument(await visible(request, request.params.id))),
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/invoices/:id/xml',
    { schema: getPublicXmlSchema, preHandler },
    async (request, reply) => {
      const invoice = await visible(request, request.params.id);
      const authorized = await withStorage(() =>
        handlers.authorizedXml.execute(tenantOf(request), invoice.id),
      );
      if (!authorized) throw new NotFoundError('Authorized XML not found');
      return reply
        .header('Content-Type', 'application/xml; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${authorized.fileName}"`)
        .send(authorized.xml);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/invoices/:id/ride',
    { schema: getPublicRideSchema, preHandler },
    async (request, reply) => {
      const invoice = await visible(request, request.params.id);
      const ride = await withStorage(() => handlers.ride.execute(tenantOf(request), invoice.id));
      if (!ride) throw new NotFoundError('RIDE not found');
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="${ride.fileName}"`)
        .send(ride.pdf);
    },
  );
}
