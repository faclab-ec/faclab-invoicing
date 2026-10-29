import { z } from 'zod';

import { LOCAL_DEFAULTS } from './local';
import { MIN_JWT_SECRET_LENGTH, PRODUCTION_DEFAULTS } from './production';
import { SRI_ENDPOINTS, SriEndpoints, SriEnvironment } from './sri';

export interface AppConfig {
  serviceName: string;
  serviceVersion: string;
  logger: {
    level: string;
  };
  http: {
    port: number;
    host: string;
    corsOrigins: string[];
  };
  externalServices: {
    // The web services of each SRI environment; an issuer's environment picks one
    sriEndpoints: Record<SriEnvironment, SriEndpoints>;
    // Only production may reach the environment with tax validity
    sriProductionAllowed: boolean;
    sriTimeoutMs: number;
  };
  signing: {
    // Base64 of a 32-byte key; encrypts the certificate passwords at rest
    passwordKey: string;
  };
  invoiceRecovery: {
    intervalMs: number;
  };
  kafka: {
    brokers: string[];
    groupId: string;
    // Company that invoices sales.confirmed v1, which names none (development only)
    salesV1TenantId: string | null;
  };
  database: {
    // PostgreSQL connection string of the faclab_invoicing database
    url: string;
  };
  // S3-compatible bucket for the authorized invoices (D-2: self-hosted on the VPS)
  objectStorage: {
    // Null for AWS itself
    endpoint: string | null;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
  };
  // Rules that the accountant may still change (D-4)
  invoicing: {
    // `sale`: when faclab-core asked to invoice the sale; `prepared`: when the XML is built
    emissionDate: EmissionDateRule;
    // Highest total of an invoice to the final consumer, in USD
    finalConsumerMaxTotal: number;
    // RUC of the invoicing system's provider, written in every invoice (Anexo 26)
    providerRuc: string | null;
  };
  auth: {
    // faclab-core's JWT_SECRET and JWT_ISSUER: access tokens are checked here
    jwtSecret: string;
    jwtIssuer: string;
  };
  timezone: string;
  environment: AppEnvironment;
}

export const EMISSION_DATE_RULES = ['sale', 'prepared'] as const;
export type EmissionDateRule = (typeof EMISSION_DATE_RULES)[number];

export const APP_ENVIRONMENTS = ['local', 'production'] as const;
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

// Every variable read here; OTEL_* are read by instrumentation.ts, which runs first
const ENV_VARS = [
  'KAFKA_BROKERS',
  'DATABASE_URL',
  'CORS_ORIGINS',
  'JWT_SECRET',
  'JWT_ISSUER',
  'CERTIFICATE_PASSWORD_KEY',
  'HTTP_PORT',
  'LOG_LEVEL',
  'SRI_TIMEOUT_MS',
  'INVOICE_RETRY_INTERVAL_MS',
  'SERVICE_VERSION',
  'SALES_V1_TENANT_ID',
  'OBJECT_STORAGE_ENDPOINT',
  'OBJECT_STORAGE_REGION',
  'OBJECT_STORAGE_BUCKET',
  'OBJECT_STORAGE_ACCESS_KEY_ID',
  'OBJECT_STORAGE_SECRET_ACCESS_KEY',
  'OBJECT_STORAGE_FORCE_PATH_STYLE',
  'INVOICE_EMISSION_DATE',
  'FINAL_CONSUMER_MAX_TOTAL',
  'INVOICING_PROVIDER_RUC',
] as const;
type EnvVar = (typeof ENV_VARS)[number];
export type EnvDefaults = Partial<Record<EnvVar, string>>;

// Defaults that don't depend on the environment
const DEFAULTS: EnvDefaults = {
  HTTP_PORT: '3173',
  JWT_ISSUER: 'faclab-core',
  SRI_TIMEOUT_MS: '30000',
  INVOICE_RETRY_INTERVAL_MS: '60000',
  // Set at build time (tag or commit SHA); instrumentation.ts reads it too
  SERVICE_VERSION: 'dev',
  OBJECT_STORAGE_FORCE_PATH_STYLE: 'true',
  INVOICE_EMISSION_DATE: 'sale',
  // ficha técnica 2.34, 9.10: above this the invoice needs the buyer's data
  FINAL_CONSUMER_MAX_TOTAL: '50',
};

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export class ConfigError extends Error {
  constructor(environment: string, problems: string[]) {
    super(
      `Invalid configuration for NODE_ENV=${environment}:\n` +
        problems.map((problem) => `- ${problem}`).join('\n'),
    );
    this.name = 'ConfigError';
  }
}

const isBlank = (value: string | undefined): value is undefined =>
  value === undefined || value.trim() === '';

const isAppEnvironment = (value: string): value is AppEnvironment =>
  (APP_ENVIRONMENTS as readonly string[]).includes(value);

const commaList = (value: string) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const positiveInt = z.coerce.number().int().positive();

const isHttpUrl = (value: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

const isPostgresUrl = (value: string) => {
  try {
    return ['postgres:', 'postgresql:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

function schemaFor(environment: AppEnvironment) {
  const production = environment === 'production';
  return z.object({
    KAFKA_BROKERS: z
      .string()
      .transform(commaList)
      .pipe(z.array(z.string()).nonempty('must list at least one broker')),
    DATABASE_URL: z
      .string()
      .refine(isPostgresUrl, 'must be a postgres:// or postgresql:// connection string'),
    CORS_ORIGINS: z
      .string()
      .transform(commaList)
      .pipe(z.array(z.string()).nonempty('must list at least one origin'))
      .refine((origins) => !production || !origins.includes('*'), "can't be * outside local"),
    JWT_SECRET: production
      ? z
          .string()
          .min(
            MIN_JWT_SECRET_LENGTH,
            `must be faclab-core's secret (at least ${MIN_JWT_SECRET_LENGTH} characters)`,
          )
      : z.string(),
    JWT_ISSUER: z.string(),
    // Losing or changing it makes every stored certificate unreadable
    CERTIFICATE_PASSWORD_KEY: z
      .string()
      .refine(
        (value) => Buffer.from(value, 'base64').length === 32,
        'must be 32 random bytes in base64',
      ),
    HTTP_PORT: z.coerce.number().int().min(1).max(65535),
    LOG_LEVEL: z.enum(LOG_LEVELS),
    SRI_TIMEOUT_MS: positiveInt,
    INVOICE_RETRY_INTERVAL_MS: positiveInt,
    SERVICE_VERSION: z.string(),
    // sales.confirmed v1 names no company: only a development setup invoices it, with this one
    SALES_V1_TENANT_ID: z
      .string()
      .uuid()
      .optional()
      .refine((value) => !production || value === undefined, "can't be set in production"),
    // Empty: AWS S3 itself
    OBJECT_STORAGE_ENDPOINT: z
      .string()
      .refine(isHttpUrl, 'must be an http:// or https:// URL')
      .optional(),
    OBJECT_STORAGE_REGION: z.string().min(1),
    OBJECT_STORAGE_BUCKET: z.string().min(1),
    OBJECT_STORAGE_ACCESS_KEY_ID: z.string().min(1),
    OBJECT_STORAGE_SECRET_ACCESS_KEY: z.string().min(1),
    OBJECT_STORAGE_FORCE_PATH_STYLE: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true'),
    INVOICE_EMISSION_DATE: z.enum(EMISSION_DATE_RULES),
    FINAL_CONSUMER_MAX_TOTAL: z.coerce.number().positive(),
    INVOICING_PROVIDER_RUC: z
      .string()
      .regex(/^\d{13}$/, 'must be a RUC of 13 digits')
      .optional(),
  });
}

// Messages name the variable but never echo its value, which may be a secret
const errorMap: z.ZodErrorMap = (issue, ctx) => {
  if (issue.code === z.ZodIssueCode.invalid_type && issue.received === z.ZodParsedType.undefined) {
    return { message: 'is required' };
  }
  if (issue.code === z.ZodIssueCode.invalid_enum_value) {
    return { message: `must be one of: ${issue.options.join(', ')}` };
  }
  return { message: ctx.defaultError };
};

/**
 * Builds the configuration from environment variables. NODE_ENV picks the defaults: `local` has one
 * for everything, `production` refuses to start without the values that depend on where it runs.
 */
export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const environment = isBlank(env.NODE_ENV) ? 'local' : env.NODE_ENV.trim();
  if (!isAppEnvironment(environment)) {
    throw new ConfigError(environment, ['NODE_ENV must be one of: local, production']);
  }

  const defaults: EnvDefaults = {
    ...DEFAULTS,
    ...(environment === 'production' ? PRODUCTION_DEFAULTS : LOCAL_DEFAULTS),
  };
  const raw = Object.fromEntries(
    ENV_VARS.map((name) => {
      const value = env[name];
      return [name, isBlank(value) ? defaults[name] : value];
    }),
  );

  const result = schemaFor(environment).safeParse(raw, { errorMap });
  if (!result.success) {
    throw new ConfigError(
      environment,
      result.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`),
    );
  }

  const values = result.data;
  return {
    serviceName: 'faclab-invoicing',
    serviceVersion: values.SERVICE_VERSION,
    logger: {
      level: values.LOG_LEVEL,
    },
    http: {
      port: values.HTTP_PORT,
      host: '0.0.0.0',
      corsOrigins: values.CORS_ORIGINS,
    },
    externalServices: {
      sriEndpoints: SRI_ENDPOINTS,
      sriProductionAllowed: environment === 'production',
      sriTimeoutMs: values.SRI_TIMEOUT_MS,
    },
    signing: {
      passwordKey: values.CERTIFICATE_PASSWORD_KEY,
    },
    invoiceRecovery: {
      intervalMs: values.INVOICE_RETRY_INTERVAL_MS,
    },
    kafka: {
      brokers: values.KAFKA_BROKERS,
      groupId: 'faclab-invoicing',
      salesV1TenantId: values.SALES_V1_TENANT_ID?.toLowerCase() ?? null,
    },
    database: {
      url: values.DATABASE_URL,
    },
    objectStorage: {
      endpoint: values.OBJECT_STORAGE_ENDPOINT ?? null,
      region: values.OBJECT_STORAGE_REGION,
      bucket: values.OBJECT_STORAGE_BUCKET,
      accessKeyId: values.OBJECT_STORAGE_ACCESS_KEY_ID,
      secretAccessKey: values.OBJECT_STORAGE_SECRET_ACCESS_KEY,
      forcePathStyle: values.OBJECT_STORAGE_FORCE_PATH_STYLE,
    },
    invoicing: {
      emissionDate: values.INVOICE_EMISSION_DATE,
      finalConsumerMaxTotal: values.FINAL_CONSUMER_MAX_TOTAL,
      providerRuc: values.INVOICING_PROVIDER_RUC ?? null,
    },
    auth: {
      jwtSecret: values.JWT_SECRET,
      jwtIssuer: values.JWT_ISSUER,
    },
    timezone: 'America/Guayaquil',
    environment,
  };
}

function loadConfig(): AppConfig {
  return parseConfig(process.env);
}

export default loadConfig;
