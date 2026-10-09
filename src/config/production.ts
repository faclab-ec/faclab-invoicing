import { AppConfig } from './index';

const jwtSecret = process.env.JWT_SECRET ?? '';
if (jwtSecret.length < 32) {
  // Same rule as faclab-core: production needs its real, long secret
  throw new Error("JWT_SECRET must be set to faclab-core's secret (at least 32 characters)");
}

export default {
  serviceName: 'faclab-invoicing',
  serviceVersion: '1.0.0',
  logger: {
    level: 'info',
  },
  http: {
    port: Number(process.env.HTTP_PORT) || 3173,
    host: '0.0.0.0',
    corsOrigins: (process.env.CORS_ORIGINS || '').split(',').filter(Boolean),
  },
  externalServices: {
    sriVoucherWsdl:
      'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline?wsdl',
    sriQueryWsdl:
      'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl',
  },
  kafka: {
    brokers: ['localhost:29092'],
    groupId: 'faclab-invoicing',
  },
  aws: {
    region: 'us-east-1',
    dynamoDb: {
      tables: {
        invoices: 'invoices',
        certificates: 'certificates',
        companyConfig: 'company_config',
      },
    },
    s3: {
      bucket: process.env.S3_CERTIFICATES_BUCKET || 'faclab-invoicing-certificates',
    },
  },
  signing: {
    p12Password: process.env.SIGNING_P12_PASSWORD!,
  },
  auth: {
    jwtSecret,
    jwtIssuer: process.env.JWT_ISSUER || 'faclab-core',
  },
  timezone: 'America/Guayaquil',
  environment: 'production',
} as AppConfig;
