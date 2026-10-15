import { createHash } from 'crypto';

import type { EnvDefaults } from './index';

// Fixed key so certificates uploaded locally survive restarts; never for production
const DEV_PASSWORD_KEY = createHash('sha256').update('dev-only-change-me').digest('base64');

// Used when the variable is unset: the faclab-infra services as seen from the host.
// A container on faclab_network overrides KAFKA_BROKERS and AWS_ENDPOINT_URL.
export const LOCAL_DEFAULTS: EnvDefaults = {
  SRI_ENVIRONMENT: 'test',
  KAFKA_BROKERS: 'localhost:29092',
  AWS_REGION: 'us-east-1',
  AWS_ENDPOINT_URL: 'http://localhost:4566',
  DYNAMODB_INVOICES_TABLE: 'invoices',
  DYNAMODB_CERTIFICATES_TABLE: 'certificates',
  DYNAMODB_COMPANY_CONFIG_TABLE: 'company_config',
  S3_CERTIFICATES_BUCKET: 'faclab-invoicing-certificates',
  CORS_ORIGINS: 'http://localhost:5173',
  // Same default as faclab-core in local
  JWT_SECRET: 'dev-only-change-me',
  CERTIFICATE_PASSWORD_KEY: DEV_PASSWORD_KEY,
  LOG_LEVEL: 'debug',
};
