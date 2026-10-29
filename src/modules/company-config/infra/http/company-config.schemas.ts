import { errorResponseSchema, successSchema } from '#/shared/infra/http/shared-schemas';

import {
  SPECIAL_TAXPAYER_RESOLUTION_PATTERN,
  WITHHOLDING_AGENT_RESOLUTION_PATTERN,
} from '../../domain/company-config';

const companyConfigResponseProperties = {
  taxId: {
    type: 'string',
    description: 'Company RUC (13-digit Ecuadorian tax ID).',
    example: '1792141001001',
  },
  name: {
    type: 'string',
    description: 'Legal company name as registered with the SRI.',
    example: 'ACME SOLUTIONS S.A.',
  },
  tradeName: {
    type: 'string',
    description: 'Commercial or trade name shown on invoices.',
    example: 'ACME',
  },
  mainAddress: {
    type: 'string',
    description:
      'Main establishment address registered with the SRI (dirMatriz). The establishment, its address and the emission point of each invoice come with the sale.',
  },
  specialTaxpayerResolution: {
    type: ['string', 'null'],
    description: 'SRI resolution number if the company is a special taxpayer. Null otherwise.',
  },
  withholdingAgentResolution: {
    type: ['string', 'null'],
    description: 'SRI resolution number if the company is a withholding agent. Null otherwise.',
  },
  rimpeRegime: {
    type: ['string', 'null'],
    enum: ['EMPRENDEDOR', 'NEGOCIO_POPULAR', null],
    description: 'RIMPE regime of the company, if it is in one. Null otherwise.',
  },
  accountingRequired: {
    type: 'boolean',
    description:
      'Whether the company is required to keep accounting records (obligado a llevar contabilidad).',
  },
  environment: {
    type: 'number',
    enum: [1, 2],
    description:
      "SRI environment of the company's invoices and the web services they go to. `1` = Testing (pruebas), `2` = Production (producción).",
    example: 1,
  },
  emissionType: {
    type: 'number',
    enum: [1],
    description: 'Emission type. `1` = Normal (currently the only supported value).',
    example: 1,
  },
  signingCertId: {
    type: ['string', 'null'],
    format: 'uuid',
    description:
      'UUID of the PKCS#12 certificate used to sign invoices. Set this to the `id` returned by the certificate upload endpoint. Null if no certificate has been configured.',
  },
  updatedAt: {
    type: 'string',
    format: 'date-time',
    description: 'Timestamp of the last configuration update (ISO 8601).',
  },
} as const;

const companyConfigObjectSchema = {
  type: 'object',
  properties: companyConfigResponseProperties,
} as const;

export const saveCompanyConfigSchema = {
  tags: ['Company Config'],
  summary: "Create or update the company's fiscal configuration",
  description:
    "Upserts the fiscal profile of the caller's company (the token's `tid`). Its sales wait as pending invoices until it is saved with a usable certificate. `branchCode`, `salePointCode`, `branchAddress` and `invoiceSequence` are ignored if sent: each sale brings its establishment and emission point, and their sequences are set with PUT /api/sequences/{establishment}/{emissionPoint}. Saving the profile never changes a sequence.",
  body: {
    type: 'object',
    required: ['taxId', 'name', 'tradeName', 'mainAddress', 'environment', 'emissionType'],
    properties: {
      taxId: {
        type: 'string',
        pattern: '^\\d{13}$',
        description: 'Company RUC — exactly 13 digits.',
      },
      name: {
        type: 'string',
        maxLength: 64,
        description: 'Legal company name (max 64 chars).',
      },
      tradeName: {
        type: 'string',
        maxLength: 64,
        description: 'Trade name (max 64 chars).',
      },
      mainAddress: { type: 'string', description: 'Main establishment address (dirMatriz).' },
      specialTaxpayerResolution: {
        type: 'string',
        pattern: SPECIAL_TAXPAYER_RESOLUTION_PATTERN.source,
        description:
          'SRI special taxpayer resolution number (optional): 3 to 13 letters or digits, as contribuyenteEspecial takes it.',
      },
      withholdingAgentResolution: {
        type: 'string',
        pattern: WITHHOLDING_AGENT_RESOLUTION_PATTERN.source,
        description:
          'SRI withholding agent resolution number (optional): up to 8 digits without leading zeros, as agenteRetencion takes it.',
      },
      rimpeRegime: {
        type: ['string', 'null'],
        enum: ['EMPRENDEDOR', 'NEGOCIO_POPULAR', null],
        description: 'RIMPE regime of the company (optional).',
      },
      accountingRequired: {
        type: 'boolean',
        description: 'Whether the company is obligated to keep accounting records.',
      },
      environment: {
        type: 'number',
        enum: [1, 2],
        description: '`1` = Testing, `2` = Production.',
      },
      emissionType: {
        type: 'number',
        enum: [1],
        description: '`1` = Normal. Only supported value.',
      },
      signingCertId: {
        type: ['string', 'null'],
        format: 'uuid',
        description:
          "UUID of the signing certificate. Use the `id` returned by POST /api/certificates. It must be one of the company's certificates and name its RUC.",
      },
    },
  },
  response: {
    200: {
      ...successSchema(companyConfigObjectSchema),
      description: 'Configuration saved successfully.',
    },
    400: { ...errorResponseSchema, description: 'Validation error or missing required fields.' },
    422: {
      ...errorResponseSchema,
      description:
        "The signing certificate is not one of the company's (`VALIDATION_ERROR`) or names another RUC (`CERTIFICATE_RUC_MISMATCH`).",
    },
  },
} as const;

export const getCompanyConfigSchema = {
  tags: ['Company Config'],
  summary: "Get the company's fiscal configuration",
  description: "Returns the fiscal profile of the caller's company.",
  response: {
    200: successSchema(companyConfigObjectSchema),
    404: { ...errorResponseSchema, description: 'No company configuration has been saved yet.' },
  },
} as const;

const sequenceObjectSchema = {
  type: 'object',
  properties: {
    establishment: { type: 'string', description: 'Establishment code (estab).', example: '001' },
    emissionPoint: { type: 'string', description: 'Emission point code (ptoEmi).', example: '002' },
    docType: { type: 'string', description: 'SRI document code: `01` = factura.', example: '01' },
    lastSequence: {
      type: ['string', 'null'],
      description: 'Last number issued, 9 digits. Null before the first one.',
      example: '000000041',
    },
    nextSequence: {
      type: 'number',
      description: 'Number the next invoice of this establishment and emission point gets.',
      example: 42,
    },
  },
} as const;

const sriCode = { type: 'string', pattern: '^(00[1-9]|0[1-9]\\d|[1-9]\\d{2})$' } as const;

export const listSequencesSchema = {
  tags: ['Company Config'],
  summary: "List the company's invoice sequences",
  description:
    'One counter per establishment and emission point that issued an invoice or had its sequence set. An emission point without a counter starts at 1.',
  response: {
    200: successSchema({ type: 'array', items: sequenceObjectSchema }),
  },
} as const;

export const setNextSequenceSchema = {
  tags: ['Company Config'],
  summary: 'Set where the invoice numbering of an emission point continues',
  description:
    'The next invoice of the establishment and emission point gets `nextSequence`, for example to continue the numbering of a previous system. It never goes back: a number already issued answers 409 `SEQUENCE_CANNOT_GO_BACK`.',
  params: {
    type: 'object',
    required: ['establishment', 'emissionPoint'],
    properties: {
      establishment: { ...sriCode, description: 'Establishment code, 001-999.' },
      emissionPoint: { ...sriCode, description: 'Emission point code, 001-999.' },
    },
  },
  body: {
    type: 'object',
    required: ['nextSequence'],
    properties: {
      nextSequence: {
        type: 'integer',
        minimum: 1,
        maximum: 999999999,
        description: 'Number the next invoice gets.',
      },
    },
  },
  response: {
    200: { ...successSchema(sequenceObjectSchema), description: 'Sequence set.' },
    400: { ...errorResponseSchema, description: 'Malformed code or number.' },
    409: {
      ...errorResponseSchema,
      description: '`SEQUENCE_CANNOT_GO_BACK`: a later number was already issued.',
    },
  },
} as const;
