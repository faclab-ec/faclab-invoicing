import type { EnvDefaults } from './index';

// Nothing that depends on where the service runs has a default here: SRI_ENVIRONMENT, KAFKA_BROKERS,
// DATABASE_URL, CORS_ORIGINS, JWT_SECRET and CERTIFICATE_PASSWORD_KEY must be set, or the process
// refuses to start.
export const PRODUCTION_DEFAULTS: EnvDefaults = {
  LOG_LEVEL: 'info',
};

// Same rule as faclab-core: production needs its real, long secret
export const MIN_JWT_SECRET_LENGTH = 32;
