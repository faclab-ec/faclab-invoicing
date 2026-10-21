import { READINESS_ERROR_CODES } from '#/modules/company-config/domain/readiness';
import {
  errorResponseSchema,
  paginatedSchema,
  successSchema,
} from '#/shared/infra/http/shared-schemas';

import { InvoiceStatus } from '../../domain/invoice';

const ISSUE_CODES = [
  ...READINESS_ERROR_CODES,
  'SRI_UNAVAILABLE',
  'SRI_PROCESSING',
  'UNEXPECTED_ERROR',
];

const statusHistorySchema = {
  type: 'object',
  description: 'A single status transition recorded on the invoice audit trail.',
  properties: {
    name: {
      type: 'string',
      description: 'Status name at the time of the transition.',
      example: 'signed',
    },
    statusDate: {
      type: 'string',
      format: 'date-time',
      description: 'ISO 8601 timestamp when the transition occurred.',
    },
    description: {
      type: 'string',
      description: 'Optional message from SRI or internal notes attached to the transition.',
    },
  },
} as const;

const issueSchema = {
  type: ['object', 'null'],
  description:
    'Why the last attempt could not move the invoice forward. Null once it moves. Issuer codes (`CONFIG_*`, `CERTIFICATE_*`) wait until the config is fixed; the rest are retried automatically.',
  properties: {
    code: { type: 'string', enum: ISSUE_CODES },
    message: { type: 'string' },
    at: { type: 'string', format: 'date-time' },
  },
} as const;

const invoiceSummaryProperties = {
  id: { type: 'string', format: 'uuid', description: 'Unique invoice identifier.' },
  saleId: { type: 'string', description: 'Identifier of the originating sale.' },
  accessCode: {
    type: ['string', 'null'],
    description:
      '49-digit SRI access code that uniquely identifies the voucher. Null while the invoice is `pending`.',
    example: '2412202401179214100100120010010000000011234567811',
  },
  status: {
    type: 'string',
    description:
      'Current lifecycle status. `pending` waits for the issuer to be ready; `authorized` and `rejected` are final.',
    enum: Object.values(InvoiceStatus),
    example: 'authorized',
  },
  signatureId: {
    type: ['string', 'null'],
    format: 'uuid',
    description: 'ID of the certificate selected when the XML was built. Null while `pending`.',
  },
  statusHistory: {
    type: 'array',
    description: 'Ordered list of all status transitions the invoice has gone through.',
    items: statusHistorySchema,
  },
  issue: issueSchema,
  attempts: {
    type: 'number',
    description: 'Failed attempts in the current status.',
  },
  nextAttemptAt: {
    type: ['string', 'null'],
    format: 'date-time',
    description:
      'When it will be retried automatically. Null if it waits for the issuer or reached the automatic limit.',
  },
  createdAt: { type: 'string', format: 'date-time' },
  updatedAt: { type: 'string', format: 'date-time' },
} as const;

const invoiceDetailProperties = {
  ...invoiceSummaryProperties,
  xml: {
    type: ['string', 'null'],
    description: 'Invoice XML in SRI format (signed from `signed` on). Null while `pending`.',
  },
} as const;

const invoiceSummaryObjectSchema = {
  type: 'object',
  properties: invoiceSummaryProperties,
} as const;

const invoiceDetailObjectSchema = {
  type: 'object',
  properties: invoiceDetailProperties,
} as const;

export const listInvoicesSchema = {
  tags: ['Invoices'],
  summary: 'List invoices',
  description:
    'Returns one page of invoice summaries, without the XML, most recently created first, and `meta.pagination` with the total. With `attention=true`, only unfinished invoices that are pending or whose last attempt failed, most recently updated first.',
  querystring: {
    type: 'object',
    properties: {
      attention: { type: 'boolean', description: 'Only invoices that need attention.' },
      status: {
        type: 'string',
        enum: Object.values(InvoiceStatus),
        description: 'Only invoices in this status.',
      },
      fromDate: {
        type: 'string',
        format: 'date',
        description: 'Created on or after this day (America/Guayaquil).',
      },
      toDate: {
        type: 'string',
        format: 'date',
        description: 'Created on or before this day (America/Guayaquil).',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 1000,
        default: 100,
        description: 'Maximum number of invoices to return (1-1000).',
      },
      offset: {
        type: 'integer',
        minimum: 0,
        default: 0,
        description: 'Number of invoices to skip.',
      },
    },
  },
  response: {
    200: paginatedSchema(invoiceSummaryObjectSchema),
  },
} as const;

export const findBySaleIdSchema = {
  tags: ['Invoices'],
  summary: 'Find invoices by sale ID',
  description: 'Returns all invoices associated with the given sale ID.',
  params: {
    type: 'object',
    properties: { saleId: { type: 'string', description: 'Sale ID.' } },
    required: ['saleId'],
  },
  response: {
    200: successSchema({ type: 'array', items: invoiceSummaryObjectSchema }),
  },
} as const;

export const getInvoiceSchema = {
  tags: ['Invoices'],
  summary: 'Get an invoice by ID',
  description: 'Returns full invoice detail including the XML and complete status history.',
  params: {
    type: 'object',
    properties: { id: { type: 'string', format: 'uuid', description: 'Invoice UUID.' } },
    required: ['id'],
  },
  response: {
    200: successSchema(invoiceDetailObjectSchema),
    404: { ...errorResponseSchema, description: 'No invoice found with the given ID.' },
  },
} as const;

export const retryInvoiceSchema = {
  tags: ['Invoices'],
  summary: 'Retry an invoice',
  description:
    'Runs the next step of an unfinished invoice now (build the XML, sign, send or ask for the authorization), ignoring its retry schedule. Returns the invoice after that step; if it fails, `issue` says why.',
  params: {
    type: 'object',
    properties: { id: { type: 'string', format: 'uuid', description: 'Invoice UUID.' } },
    required: ['id'],
  },
  response: {
    200: successSchema(invoiceSummaryObjectSchema),
    404: { ...errorResponseSchema, description: 'No invoice found with the given ID.' },
    409: {
      ...errorResponseSchema,
      description: '`INVOICE_NOT_RETRYABLE`: the invoice is already authorized or rejected.',
    },
  },
} as const;

export const retryInvoicesSchema = {
  tags: ['Invoices'],
  summary: 'Retry every invoice that needs attention',
  description:
    'Queues every unfinished invoice that is pending or whose last attempt failed, and processes them in the background. Invoices waiting for the issuer are skipped while it is not ready.',
  response: {
    202: successSchema({
      type: 'object',
      properties: { queued: { type: 'number', description: 'Invoices that need attention.' } },
    }),
  },
} as const;

export const invoicingStatusSchema = {
  tags: ['Invoices'],
  summary: 'Whether the issuer can invoice',
  description:
    'Checks the company config and the selected certificate (present, not expired, readable with its password). Errors stop invoicing: new invoices wait as `pending` until they are fixed. Warnings do not. Also counts the unfinished invoices.',
  response: {
    200: successSchema({
      type: 'object',
      properties: {
        ready: { type: 'boolean', description: 'False if there is any error issue.' },
        environment: {
          type: ['number', 'null'],
          enum: [1, 2, null],
          description: 'SRI environment from the config: `1` testing, `2` production.',
        },
        certificate: {
          type: ['object', 'null'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            subject: { type: 'string' },
            validTo: { type: 'string', format: 'date-time' },
          },
        },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                enum: [...READINESS_ERROR_CODES, 'CERTIFICATE_EXPIRING_SOON', 'TEST_ENVIRONMENT'],
              },
              severity: { type: 'string', enum: ['error', 'warning'] },
              message: { type: 'string' },
            },
          },
        },
        pendingInvoices: {
          type: 'number',
          description: 'Invoices not yet authorized or rejected.',
        },
        invoicesWithIssues: {
          type: 'number',
          description: 'Unfinished invoices whose last attempt failed.',
        },
      },
    }),
  },
} as const;
