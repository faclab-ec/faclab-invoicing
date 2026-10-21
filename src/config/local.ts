import { createHash } from 'crypto';

import type { EnvDefaults } from './index';

// Fixed key so certificates uploaded locally survive restarts; never for production
const DEV_PASSWORD_KEY = createHash('sha256').update('dev-only-change-me').digest('base64');

// Used when the variable is unset: the faclab-infra services as seen from the host.
// A container on faclab_network overrides KAFKA_BROKERS and DATABASE_URL (invoicing-db:5432).
export const LOCAL_DEFAULTS: EnvDefaults = {
  SRI_ENVIRONMENT: 'test',
  KAFKA_BROKERS: 'localhost:29092',
  // faclab-infra's invoicing-db; development-only password
  DATABASE_URL: 'postgres://faclab_invoicing:faclab_invoicing@localhost:5434/faclab_invoicing',
  CORS_ORIGINS: 'http://localhost:5173',
  // Same default as faclab-core in local
  JWT_SECRET: 'dev-only-change-me',
  CERTIFICATE_PASSWORD_KEY: DEV_PASSWORD_KEY,
  LOG_LEVEL: 'debug',
};
