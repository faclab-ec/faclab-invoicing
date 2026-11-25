import { FastifyInstance } from 'fastify';

import { Authorize, tenantOf } from '#/shared/infra/http/auth';
import { errorResponseSchema, successSchema } from '#/shared/infra/http/shared-schemas';
import { logger } from '#/shared/logger';

import {
  GetTestInvoiceQuery,
  SubmitTestInvoiceCommand,
  TestInvoiceInput,
} from '../../app/commands/onboarding-test-invoice';
import { Invoice, InvoiceStatus } from '../../domain/invoice';

export interface OnboardingHandlers {
  submitTestInvoice: SubmitTestInvoiceCommand;
  getTestInvoice: GetTestInvoiceQuery;
}

const testInvoiceObject = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: ['NONE', 'PROCESSING', 'AUTHORIZED', 'REJECTED'],
      description:
        '`NONE` before the first test invoice; `PROCESSING` while it goes through the SRI; `AUTHORIZED` when the SRI accepted it; `REJECTED` with the reason.',
    },
    id: { type: ['string', 'null'], format: 'uuid' },
    number: { type: ['string', 'null'], description: '001-001-000000001, once it has one.' },
    authorizedAt: { type: ['string', 'null'], format: 'date-time' },
    reason: {
      type: ['string', 'null'],
      description: 'Why it was rejected, or what holds it back.',
    },
  },
} as const;

const testInvoiceSchema = {
  tags: ['Onboarding'],
  response: {
    200: successSchema(testInvoiceObject),
    409: { ...errorResponseSchema, description: 'The issuer is not ready or is in production.' },
  },
} as const;

export function toTestInvoiceResponse(invoice: Invoice | null) {
  if (!invoice) {
    return { status: 'NONE', id: null, number: null, authorizedAt: null, reason: null };
  }
  const last = invoice.statusHistory[invoice.statusHistory.length - 1];
  const status =
    invoice.status === InvoiceStatus.AUTHORIZED
      ? 'AUTHORIZED'
      : invoice.status === InvoiceStatus.REJECTED
        ? 'REJECTED'
        : 'PROCESSING';
  return {
    status,
    id: invoice.id,
    number: invoice.number,
    authorizedAt: invoice.authorization?.authorizedAt ?? null,
    reason:
      status === 'REJECTED'
        ? (last?.description ?? invoice.issue?.message ?? null)
        : (invoice.issue?.message ?? null),
  };
}

/**
 * The test invoice of the onboarding (S8.5): proves the certificate, the profile and the SRI test
 * environment with a one cent invoice to the final consumer, before going to production.
 */
export function registerOnboardingRoutes(
  app: FastifyInstance,
  handlers: OnboardingHandlers,
  authorize: Authorize,
): void {
  // The company's own settings, like the profile and the certificate
  const preHandler = authorize('user:manage');

  app.post<{ Body: TestInvoiceInput | undefined }>(
    '/api/invoicing/test-invoice',
    {
      schema: {
        ...testInvoiceSchema,
        summary: 'Issue the test invoice of the onboarding',
        description:
          "Sends a one cent invoice to the final consumer through the whole pipeline against the SRI's test environment. Only with the issuer ready and in the test environment. Answers the one already in progress or authorized instead of a second. Read its result with GET.",
        body: {
          type: ['object', 'null'],
          properties: {
            establishment: { type: 'string', pattern: '^\\d{3}$', default: '001' },
            emissionPoint: { type: 'string', pattern: '^\\d{3}$', default: '001' },
          },
          additionalProperties: false,
        },
      },
      preHandler,
    },
    async (request, reply) => {
      const invoice = await handlers.submitTestInvoice.execute(
        tenantOf(request),
        request.body ?? {},
      );
      logger.info(
        { 'event.name': 'onboarding.test_invoice.requested', invoiceId: invoice.id },
        'Test invoice requested',
      );
      return reply.success(toTestInvoiceResponse(invoice));
    },
  );

  app.get(
    '/api/invoicing/test-invoice',
    {
      schema: {
        ...testInvoiceSchema,
        summary: 'The latest test invoice of the onboarding',
        description: 'Its status, number and the SRI reason when it was rejected.',
      },
      preHandler,
    },
    async (request, reply) => {
      const invoice = await handlers.getTestInvoice.execute(tenantOf(request));
      return reply.success(toTestInvoiceResponse(invoice));
    },
  );
}
