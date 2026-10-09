import { FastifyInstance } from 'fastify';

import { NotFoundError } from '#/shared/errors/app-error';
import { Authorize } from '#/shared/infra/http/auth';

import {
  FindInvoicesBySaleIdQuery,
  GetInvoiceQuery,
  ListInvoicesQuery,
} from '../../app/queries/invoice.queries';
import { toDetailResponse, toSummaryResponse } from './invoice.mapper';
import { findBySaleIdSchema, getInvoiceSchema, listInvoicesSchema } from './invoice.schemas';

export interface InvoiceQueries {
  get: GetInvoiceQuery;
  list: ListInvoicesQuery;
  findBySaleId: FindInvoicesBySaleIdQuery;
}

export function registerInvoiceRoutes(
  app: FastifyInstance,
  queries: InvoiceQueries,
  authorize: Authorize,
): void {
  // Invoices are read like sales in faclab-core
  const preHandler = authorize('sale:read');

  // GET /api/invoices — list all
  app.get('/api/invoices', { schema: listInvoicesSchema, preHandler }, async (_request, reply) => {
    const invoices = await queries.list.execute();
    return reply.success(invoices.map(toSummaryResponse));
  });

  // GET /api/invoices/by-sale/:saleId — find by sale ID
  app.get<{ Params: { saleId: string } }>(
    '/api/invoices/by-sale/:saleId',
    { schema: findBySaleIdSchema, preHandler },
    async (request, reply) => {
      const invoices = await queries.findBySaleId.execute(request.params.saleId);
      return reply.success(invoices.map(toSummaryResponse));
    },
  );

  // GET /api/invoices/:id — get by ID
  app.get<{ Params: { id: string } }>(
    '/api/invoices/:id',
    { schema: getInvoiceSchema, preHandler },
    async (request, reply) => {
      const invoice = await queries.get.execute(request.params.id);
      if (!invoice) {
        throw new NotFoundError('Invoice not found');
      }
      return reply.success(toDetailResponse(invoice));
    },
  );
}
