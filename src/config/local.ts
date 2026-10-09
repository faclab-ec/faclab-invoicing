import { createHash } from 'crypto';

import { AppConfig } from './index';

// Fixed key so certificates uploaded locally survive restarts; never for production
const DEV_PASSWORD_KEY = createHash('sha256').update('dev-only-change-me').digest('base64');

export default {
  serviceName: 'faclab-invoicing',
  serviceVersion: '1.0.0',
  logger: {
    level: 'debug',
  },
  http: {
    port: 3173,
    host: '0.0.0.0',
    corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173').split(','),
  },
  externalServices: {
    sriVoucherWsdl:
      'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline?wsdl',
    sriQueryWsdl:
      'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl',
    sriTimeoutMs: Number(process.env.SRI_TIMEOUT_MS) || 30_000,
  },
  kafka: {
    brokers: ['localhost:29092'],
    groupId: 'faclab-invoicing',
  },
  aws: {
    region: 'us-east-1',
    endpoint: 'http://localhost:4566',
    dynamoDb: {
      tables: {
        invoices: 'invoices',
        certificates: 'certificates',
        companyConfig: 'company_config',
      },
    },
    s3: {
      bucket: 'faclab-invoicing-certificates',
    },
  },
  signing: {
    passwordKey: process.env.CERTIFICATE_PASSWORD_KEY || DEV_PASSWORD_KEY,
  },
  invoiceRecovery: {
    intervalMs: Number(process.env.INVOICE_RETRY_INTERVAL_MS) || 60_000,
  },
  auth: {
    // Same default as faclab-core in local
    jwtSecret: process.env.JWT_SECRET || 'dev-only-change-me',
    jwtIssuer: process.env.JWT_ISSUER || 'faclab-core',
  },
  timezone: 'America/Guayaquil',
  environment: 'local',
} as AppConfig;
