import {
  errorResponseSchema,
  paginatedSchema,
  successSchema,
} from '#/shared/infra/http/shared-schemas';

import {
  DOCUMENT_TYPES,
  PUBLIC_STATUSES,
  SORT_FIELDS,
} from '../../../app/queries/public-invoice.queries';

// The public API's contract for the electronic documents (S6.3): schemas of their own, never the
// internal ones. Every property is always sent (null when it has no value)

const TAGS = ['Invoices'];
const SCOPE = 'invoices:read';
const security = [{ clientCredentials: [SCOPE] }];

const nullable = (type: string, extra: object = {}) => ({ type: [type, 'null'], ...extra });

const documentProperties = {
  id: { type: 'string', format: 'uuid', description: 'The document.' },
  documentType: {
    type: 'string',
    enum: Object.keys(DOCUMENT_TYPES),
    description: 'An invoice, or a credit note of a refund or a cancelled sale.',
  },
  saleId: { type: 'integer', description: 'The sale in faclab-core (`/api/v1/sales/{id}`).' },
  creditedInvoiceId: nullable('string', {
    format: 'uuid',
    description: 'The invoice a credit note modifies; null in an invoice.',
  }),
  branchId: nullable('integer', {
    description: "The sale's branch in faclab-core; null in documents from before it was kept.",
  }),
  establishment: { type: 'string', description: 'SRI establishment code (001).' },
  emissionPoint: { type: 'string', description: 'SRI emission point code (002).' },
  number: nullable('string', {
    description: 'Its number, 001-002-000000123, once it has one.',
  }),
  accessCode: nullable('string', { description: 'The 49-digit SRI access code, once it has one.' }),
  status: {
    type: 'string',
    enum: PUBLIC_STATUSES,
    description:
      'PROCESSING while it is on its way to the SRI (it may wait for the issuer to be ready), AUTHORIZED or REJECTED. New values may be added.',
  },
  authorizationNumber: nullable('string', { description: "The SRI's authorization." }),
  authorizedAt: nullable('string', { format: 'date-time' }),
  rejectionReason: nullable('string', { description: "The SRI's messages, when REJECTED." }),
  total: nullable('string', {
    pattern: '^\\d+(\\.\\d{1,6})?$',
    description: 'Its total with VAT in USD, as a decimal string.',
  }),
  createdAt: { type: 'string', format: 'date-time' },
  updatedAt: { type: 'string', format: 'date-time' },
} as const;

const documentSchema = {
  type: 'object',
  properties: documentProperties,
  required: Object.keys(documentProperties),
  additionalProperties: false,
} as const;

const responses = {
  401: { ...errorResponseSchema, description: '`INVALID_TOKEN` or `TOKEN_EXPIRED`.' },
  403: {
    ...errorResponseSchema,
    description:
      "`INSUFFICIENT_SCOPE` without `invoices:read`, `PERMISSION_DENIED` with a token that is not an integration client's, `BRANCH_ACCESS_DENIED` for a branch it may not see.",
  },
  422: { ...errorResponseSchema, description: '`VALIDATION_ERROR`.' },
  429: { ...errorResponseSchema, description: '`RATE_LIMITED`: retry after `Retry-After`.' },
  503: {
    ...errorResponseSchema,
    description: "`PUBLIC_API_DISABLED`, or `AUTH_UNAVAILABLE` without faclab-core's keys.",
  },
};

const idParams = {
  type: 'object',
  properties: { id: { type: 'string', format: 'uuid' } },
  required: ['id'],
} as const;

export const listPublicInvoicesSchema = {
  tags: TAGS,
  summary: 'List invoices and credit notes',
  description:
    "The electronic documents of the company's sales in the branches this client may see. Sync them with `updatedSince` (ordered by `updatedAt`, then id); `from` and `to` filter by when they were created. `sort`: `createdAt`, `updatedAt` or `id`, with a leading `-` descending.",
  security,
  querystring: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      offset: { type: 'integer', minimum: 0, default: 0 },
      sort: {
        type: 'string',
        enum: SORT_FIELDS.flatMap((field) => [field, `-${field}`]),
      },
      saleId: { type: 'integer', minimum: 1 },
      status: { type: 'string', enum: PUBLIC_STATUSES },
      documentType: { type: 'string', enum: Object.keys(DOCUMENT_TYPES) },
      branchId: { type: 'integer', minimum: 1 },
      from: { type: 'string', format: 'date-time' },
      to: { type: 'string', format: 'date-time' },
      updatedSince: { type: 'string', format: 'date-time' },
    },
  },
  response: { 200: paginatedSchema(documentSchema), ...responses },
} as const;

export const getPublicInvoiceSchema = {
  tags: TAGS,
  summary: 'Get an invoice or credit note',
  description: 'A document of a branch this client may see.',
  security,
  params: idParams,
  response: {
    200: successSchema(documentSchema),
    404: { ...errorResponseSchema, description: '`NOT_FOUND`.' },
    ...responses,
  },
} as const;

export const getPublicXmlSchema = {
  tags: TAGS,
  summary: 'Download the authorized XML',
  description:
    'The authorized document as the SRI returned it (`autorizacion` with the signed voucher), as an attachment named after its access code. 404 until it is authorized.',
  security,
  params: idParams,
  produces: ['application/xml'],
  response: {
    200: {
      description: 'The authorized XML.',
      content: { 'application/xml': { schema: { type: 'string' } } },
    },
    404: {
      ...errorResponseSchema,
      description: '`NOT_FOUND`: no such document, or not authorized yet.',
    },
    ...responses,
  },
} as const;

export const getPublicRideSchema = {
  tags: TAGS,
  summary: 'Download the RIDE (PDF)',
  description:
    'The printable PDF of the authorized document, as an attachment named after its access code. 404 until it is authorized.',
  security,
  params: idParams,
  produces: ['application/pdf'],
  response: {
    200: {
      description: 'The RIDE.',
      content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
    },
    404: {
      ...errorResponseSchema,
      description: '`NOT_FOUND`: no such document, or not authorized yet.',
    },
    ...responses,
  },
} as const;
