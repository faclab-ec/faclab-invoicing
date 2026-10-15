import { z } from 'zod';

import { LOCAL_DEFAULTS } from './local';
import { MIN_JWT_SECRET_LENGTH, PRODUCTION_DEFAULTS } from './production';
import { SRI_ENDPOINTS, SRI_ENVIRONMENTS, SriEnvironment } from './sri';

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
    sriEnvironment: SriEnvironment;
    sriVoucherWsdl: string;
    sriQueryWsdl: string;
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
  };
  aws: {
    region: string;
    endpoint?: string;
    dynamoDb: {
      tables: {
        invoices: string;
        certificates: string;
        companyConfig: string;
      };
    };
    s3: {
      bucket: string;
    };
  };
  auth: {
    // faclab-core's JWT_SECRET and JWT_ISSUER: access tokens are checked here
    jwtSecret: string;
    jwtIssuer: string;
  };
  timezone: string;
  environment: AppEnvironment;
}

export const APP_ENVIRONMENTS = ['local', 'production'] as const;
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

// Every variable read here; OTEL_* are read by instrumentation.ts, which runs first
const ENV_VARS = [
  'SRI_ENVIRONMENT',
  'KAFKA_BROKERS',
  'AWS_REGION',
  'AWS_ENDPOINT_URL',
  'DYNAMODB_INVOICES_TABLE',
  'DYNAMODB_CERTIFICATES_TABLE',
  'DYNAMODB_COMPANY_CONFIG_TABLE',
  'S3_CERTIFICATES_BUCKET',
  'CORS_ORIGINS',
  'JWT_SECRET',
  'JWT_ISSUER',
  'CERTIFICATE_PASSWORD_KEY',
  'HTTP_PORT',
  'LOG_LEVEL',
  'SRI_TIMEOUT_MS',
  'INVOICE_RETRY_INTERVAL_MS',
] as const;
type EnvVar = (typeof ENV_VARS)[number];
export type EnvDefaults = Partial<Record<EnvVar, string>>;

// Defaults that don't depend on the environment
const DEFAULTS: EnvDefaults = {
  HTTP_PORT: '3173',
  JWT_ISSUER: 'faclab-core',
  SRI_TIMEOUT_MS: '30000',
  INVOICE_RETRY_INTERVAL_MS: '60000',
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

function schemaFor(environment: AppEnvironment) {
  const production = environment === 'production';
  return z.object({
    // Only production may reach the SRI environment with tax validity
    SRI_ENVIRONMENT: z
      .enum(SRI_ENVIRONMENTS)
      .refine((value) => production || value === 'test', 'must be test outside production'),
    KAFKA_BROKERS: z
      .string()
      .transform(commaList)
      .pipe(z.array(z.string()).nonempty('must list at least one broker')),
    AWS_REGION: z.string(),
    // Unset in production means the real AWS endpoints
    AWS_ENDPOINT_URL: z.string().url('must be a URL').optional(),
    DYNAMODB_INVOICES_TABLE: z.string(),
    DYNAMODB_CERTIFICATES_TABLE: z.string(),
    DYNAMODB_COMPANY_CONFIG_TABLE: z.string(),
    S3_CERTIFICATES_BUCKET: z.string(),
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
  const sri = SRI_ENDPOINTS[values.SRI_ENVIRONMENT];
  return {
    serviceName: 'faclab-invoicing',
    serviceVersion: '1.0.0',
    logger: {
      level: values.LOG_LEVEL,
    },
    http: {
      port: values.HTTP_PORT,
      host: '0.0.0.0',
      corsOrigins: values.CORS_ORIGINS,
    },
    externalServices: {
      sriEnvironment: values.SRI_ENVIRONMENT,
      sriVoucherWsdl: sri.receptionWsdl,
      sriQueryWsdl: sri.authorizationWsdl,
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
    },
    aws: {
      region: values.AWS_REGION,
      endpoint: values.AWS_ENDPOINT_URL,
      dynamoDb: {
        tables: {
          invoices: values.DYNAMODB_INVOICES_TABLE,
          certificates: values.DYNAMODB_CERTIFICATES_TABLE,
          companyConfig: values.DYNAMODB_COMPANY_CONFIG_TABLE,
        },
      },
      s3: {
        bucket: values.S3_CERTIFICATES_BUCKET,
      },
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
