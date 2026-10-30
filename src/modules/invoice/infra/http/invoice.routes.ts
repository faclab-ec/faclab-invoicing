import { FastifyInstance } from 'fastify';

import { NotFoundError } from '#/shared/errors/app-error';
import { Authorize, tenantOf } from '#/shared/infra/http/auth';
import { withStorage } from '#/shared/infra/http/storage';

import { RetryInvoiceCommand, RetryInvoicesCommand } from '../../app/commands/retry-invoice';
import {
  FindInvoicesBySaleIdQuery,
  GetAuthorizedXmlQuery,
  GetInvoiceQuery,
  GetInvoicingStatusQuery,
  GetRideQuery,
  ListInvoicesOptions,
  ListInvoicesQuery,
} from '../../app/queries/invoice.queries';
import { toDetailResponse, toStatusResponse, toSummaryResponse } from './invoice.mapper';
import {
  findBySaleIdSchema,
  getAuthorizedXmlSchema,
  getInvoiceSchema,
  getRideSchema,
  invoicingStatusSchema,
  listInvoicesSchema,
  retryInvoiceSchema,
  retryInvoicesSchema,
} from './invoice.schemas';

export interface InvoiceHandlers {
  get: GetInvoiceQuery;
  authorizedXml: GetAuthorizedXmlQuery;
  ride: GetRideQuery;
  list: ListInvoicesQuery;
  findBySaleId: FindInvoicesBySaleIdQuery;
  status: GetInvoicingStatusQuery;
  retry: RetryInvoiceCommand;
  retryAll: RetryInvoicesCommand;
}

export function registerInvoiceRoutes(
  app: FastifyInstance,
  handlers: InvoiceHandlers,
  authorize: Authorize,
): void {
  // Invoices are read like sales in faclab-core, always those of the token's company
  const canRead = authorize('sale:read');
  // Retrying only finishes what a sale already started: whoever can sell can do it
  const canRetry = authorize('sale:write');

  // GET /api/invoicing/status — can the issuer invoice?
  app.get(
    '/api/invoicing/status',
    { schema: invoicingStatusSchema, preHandler: canRead },
    async (request, reply) => {
      const status = await handlers.status.execute(tenantOf(request));
      return reply.success(toStatusResponse(status));
    },
  );

  // GET /api/invoices — one page, optionally only those that need attention
  app.get<{ Querystring: ListInvoicesOptions }>(
    '/api/invoices',
    { schema: listInvoicesSchema, preHandler: canRead },
    async (request, reply) => {
      // The schema fills in the default limit and offset
      const { limit, offset } = request.query;
      const page = await handlers.list.execute(tenantOf(request), request.query);
      return reply.success(page.items.map(toSummaryResponse), {
        pagination: { total: page.total, limit, offset },
      });
    },
  );

  // POST /api/invoices/retry — retry every invoice that needs attention
  app.post(
    '/api/invoices/retry',
    { schema: retryInvoicesSchema, preHandler: canRetry },
    async (request, reply) => {
      const queued = await handlers.retryAll.execute(tenantOf(request));
      reply.code(202);
      return reply.success({ queued });
    },
  );

  // GET /api/invoices/by-sale/:saleId — find by sale ID
  app.get<{ Params: { saleId: string } }>(
    '/api/invoices/by-sale/:saleId',
    { schema: findBySaleIdSchema, preHandler: canRead },
    async (request, reply) => {
      const invoices = await handlers.findBySaleId.execute(
        tenantOf(request),
        request.params.saleId,
      );
      return reply.success(invoices.map(toSummaryResponse));
    },
  );

  // GET /api/invoices/:id — get by ID
  app.get<{ Params: { id: string } }>(
    '/api/invoices/:id',
    { schema: getInvoiceSchema, preHandler: canRead },
    async (request, reply) => {
      const invoice = await handlers.get.execute(tenantOf(request), request.params.id);
      if (!invoice) {
        throw new NotFoundError('Invoice not found');
      }
      return reply.success(toDetailResponse(invoice));
    },
  );

  // GET /api/invoices/:id/authorized-xml — the authorized invoice, as a file
  app.get<{ Params: { id: string } }>(
    '/api/invoices/:id/authorized-xml',
    { schema: getAuthorizedXmlSchema, preHandler: canRead },
    async (request, reply) => {
      const authorized = await withStorage(() =>
        handlers.authorizedXml.execute(tenantOf(request), request.params.id),
      );
      if (!authorized) {
        throw new NotFoundError('Authorized XML not found');
      }
      return reply
        .header('Content-Type', 'application/xml; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${authorized.fileName}"`)
        .send(authorized.xml);
    },
  );

  // GET /api/invoices/:id/ride — its RIDE, the printable PDF
  app.get<{ Params: { id: string } }>(
    '/api/invoices/:id/ride',
    { schema: getRideSchema, preHandler: canRead },
    async (request, reply) => {
      const ride = await withStorage(() =>
        handlers.ride.execute(tenantOf(request), request.params.id),
      );
      if (!ride) {
        throw new NotFoundError('RIDE not found');
      }
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="${ride.fileName}"`)
        .send(ride.pdf);
    },
  );

  // POST /api/invoices/:id/retry — run its next step now
  app.post<{ Params: { id: string } }>(
    '/api/invoices/:id/retry',
    { schema: retryInvoiceSchema, preHandler: canRetry },
    async (request, reply) => {
      const invoice = await handlers.retry.execute(tenantOf(request), request.params.id);
      return reply.success(toSummaryResponse(invoice));
    },
  );
}
