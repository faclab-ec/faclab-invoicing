import { errorResponseSchema, successSchema } from '#/shared/infra/http/shared-schemas';

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
    description: 'Main establishment address registered with the SRI.',
  },
  branchAddress: { type: 'string', description: 'Branch address printed on invoices.' },
  branchCode: {
    type: 'string',
    description: 'Branch code used in invoice numbering (001–999).',
    example: '001',
  },
  salePointCode: {
    type: 'string',
    description: 'Point-of-sale code used in invoice numbering (001–999).',
    example: '001',
  },
  specialTaxpayerResolution: {
    type: ['string', 'null'],
    description: 'SRI resolution number if the company is a special taxpayer. Null otherwise.',
  },
  withholdingAgentResolution: {
    type: ['string', 'null'],
    description: 'SRI resolution number if the company is a withholding agent. Null otherwise.',
  },
  accountingRequired: {
    type: 'boolean',
    description:
      'Whether the company is required to keep accounting records (obligado a llevar contabilidad).',
  },
  environment: {
    type: 'number',
    enum: [1, 2],
    description: 'SRI environment. `1` = Testing (pruebas), `2` = Production (producción).',
    example: 1,
  },
  emissionType: {
    type: 'number',
    enum: [1],
    description: 'Emission type. `1` = Normal (currently the only supported value).',
    example: 1,
  },
  invoiceSequence: {
    type: 'number',
    description:
      'Current sequential invoice counter. Auto-incremented on each invoice creation. Can be seeded on first setup.',
    example: 42,
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
  summary: 'Create or update the company fiscal configuration',
  description:
    'Upserts the singleton company configuration used when generating invoices. This must be configured before the service can process any `sales.confirmed` Kafka events. The `invoiceSequence` field is optional — if omitted, the current counter is preserved.',
  body: {
    type: 'object',
    required: [
      'taxId',
      'name',
      'tradeName',
      'mainAddress',
      'branchAddress',
      'branchCode',
      'salePointCode',
      'environment',
      'emissionType',
    ],
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
      mainAddress: { type: 'string', description: 'Main establishment address.' },
      branchAddress: { type: 'string', description: 'Branch address printed on invoices.' },
      branchCode: {
        type: 'string',
        pattern: '^\\d{3}$',
        description: 'Branch code: exactly 3 digits (e.g. `001`).',
      },
      salePointCode: {
        type: 'string',
        pattern: '^\\d{3}$',
        description: 'Point-of-sale code: exactly 3 digits (e.g. `001`).',
      },
      specialTaxpayerResolution: {
        type: 'string',
        maxLength: 32,
        description: 'SRI special taxpayer resolution number (optional).',
      },
      withholdingAgentResolution: {
        type: 'string',
        maxLength: 32,
        description: 'SRI withholding agent resolution number (optional).',
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
      invoiceSequence: {
        type: 'number',
        minimum: 1,
        description:
          'Seed value for the invoice sequence counter. Optional — preserves the existing counter if omitted.',
      },
      signingCertId: {
        type: ['string', 'null'],
        format: 'uuid',
        description:
          'UUID of the signing certificate. Use the `id` returned by POST /api/certificates. It must exist.',
      },
    },
  },
  response: {
    200: {
      ...successSchema(companyConfigObjectSchema),
      description: 'Configuration saved successfully.',
    },
    400: { ...errorResponseSchema, description: 'Validation error or missing required fields.' },
    422: { ...errorResponseSchema, description: 'The signing certificate does not exist.' },
  },
} as const;

export const getCompanyConfigSchema = {
  tags: ['Company Config'],
  summary: 'Get the company fiscal configuration',
  description: 'Returns the current singleton company configuration.',
  response: {
    200: successSchema(companyConfigObjectSchema),
    404: { ...errorResponseSchema, description: 'No company configuration has been saved yet.' },
  },
} as const;
