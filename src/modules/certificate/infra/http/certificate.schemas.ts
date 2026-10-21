import { errorResponseSchema, successSchema } from '#/shared/infra/http/shared-schemas';

const certificateResponseProperties = {
  id: {
    type: 'string',
    format: 'uuid',
    description:
      'Unique certificate identifier. Set this value as the `signingCertId` in the company configuration (PUT /api/company-config).',
  },
  serialNumber: {
    type: 'string',
    description: 'Serial number extracted from the X.509 certificate inside the .p12 file.',
  },
  subject: {
    type: 'string',
    description: 'Distinguished Name (DN) of the certificate subject in RFC 4514 format.',
    example: 'CN=JUAN PEREZ, O=BCE, C=EC',
  },
  issuer: {
    type: 'string',
    description:
      'Distinguished Name (DN) of the Certificate Authority that issued this certificate.',
    example: 'CN=BCE ENTIDAD CERTIFICADORA, O=BCE, C=EC',
  },
  validFrom: {
    type: 'string',
    format: 'date-time',
    description: 'Certificate validity start date (ISO 8601).',
  },
  validTo: {
    type: 'string',
    format: 'date-time',
    description: 'Certificate expiry date (ISO 8601). Invoices cannot be signed after this date.',
  },
  fileName: {
    type: 'string',
    description: 'Original filename of the uploaded .p12 file.',
    example: 'firma_electronica.p12',
  },
  uploadedAt: {
    type: 'string',
    format: 'date-time',
    description: 'Timestamp when the certificate was uploaded (ISO 8601).',
  },
} as const;

const certificateObjectSchema = {
  type: 'object',
  properties: certificateResponseProperties,
} as const;

export const uploadCertificateSchema = {
  tags: ['Certificates'],
  summary: 'Upload a .p12 digital signature certificate',
  description:
    'Accepts a PKCS#12 (.p12) file and its password. The service parses the certificate metadata and stores it with the file and its password, both encrypted. The returned `id` should be saved as the `signingCertId` field in the company configuration (PUT /api/company-config) so the service uses this certificate to sign invoices.',
  multipartBody: {
    type: 'object',
    required: ['file', 'password'],
    properties: {
      file: {
        type: 'string',
        format: 'binary',
        description:
          'PKCS#12 (.p12) certificate file issued by a trusted CA (e.g. BCE, Security Data, ANF).',
      },
      password: {
        type: 'string',
        description: 'Password that protects the .p12 file. Required to extract the private key.',
      },
    },
  },
  response: {
    201: {
      ...successSchema(certificateObjectSchema),
      description: 'Certificate uploaded and parsed successfully.',
    },
    400: {
      ...errorResponseSchema,
      description: 'Missing file, wrong file extension, or invalid request.',
    },
    422: {
      ...errorResponseSchema,
      description: 'File could not be parsed — wrong password or corrupted .p12.',
    },
  },
} as const;

export const listCertificatesSchema = {
  tags: ['Certificates'],
  summary: 'List all certificates',
  description: 'Returns all certificates stored in the system.',
  response: {
    200: successSchema({ type: 'array', items: certificateObjectSchema }),
  },
} as const;

export const getCertificateSchema = {
  tags: ['Certificates'],
  summary: 'Get a certificate by ID',
  description: 'Returns the metadata for a single certificate.',
  params: {
    type: 'object',
    properties: { id: { type: 'string', format: 'uuid', description: 'Certificate UUID.' } },
    required: ['id'],
  },
  response: {
    200: successSchema(certificateObjectSchema),
    404: { ...errorResponseSchema, description: 'No certificate found with the given ID.' },
  },
} as const;

export const deleteCertificateSchema = {
  tags: ['Certificates'],
  summary: 'Delete a certificate',
  description:
    'Deletes the certificate, its file and its password. If this certificate is currently set as the `signingCertId` in company configuration, invoice signing will fail until a new certificate is configured.',
  params: {
    type: 'object',
    properties: { id: { type: 'string', format: 'uuid', description: 'Certificate UUID.' } },
    required: ['id'],
  },
  response: {
    204: { type: 'null', description: 'Certificate deleted successfully.' },
    404: { ...errorResponseSchema, description: 'No certificate found with the given ID.' },
  },
} as const;
