import { randomBytes } from 'crypto';
import { describe, expect, it } from 'vitest';

import { ConfigError, parseConfig } from '#/config';

const JWT_SECRET = randomBytes(32).toString('hex');
const CERTIFICATE_PASSWORD_KEY = randomBytes(32).toString('base64');
const DATABASE_URL = `postgres://faclab_invoicing:${randomBytes(8).toString('hex')}@db:5432/faclab_invoicing`;
const STORAGE_SECRET = randomBytes(32).toString('hex');
const SMTP_PASSWORD = randomBytes(16).toString('hex');

const production = (overrides: Record<string, string | undefined> = {}) => ({
  NODE_ENV: 'production',
  KAFKA_BROKERS: 'kafka-1:9092,kafka-2:9092',
  DATABASE_URL,
  CORS_ORIGINS: 'https://app.faclab.test',
  JWT_SECRET,
  CERTIFICATE_PASSWORD_KEY,
  OBJECT_STORAGE_ENDPOINT: 'http://object-storage:3900',
  OBJECT_STORAGE_REGION: 'garage',
  OBJECT_STORAGE_BUCKET: 'faclab-invoicing',
  OBJECT_STORAGE_ACCESS_KEY_ID: 'GK0123456789abcdef0123456789abcdef',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: STORAGE_SECRET,
  SMTP_HOST: 'smtp.provider.test',
  SMTP_USER: 'faclab',
  SMTP_PASSWORD,
  INVOICE_EMAIL_FROM: 'comprobantes@faclab.test',
  ...overrides,
});

const errorOf = (env: Record<string, string | undefined>) => {
  try {
    parseConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).message;
  }
  throw new Error('parseConfig did not fail');
};

describe('parseConfig in local', () => {
  it('defaults to local with the faclab-infra services, only reaching the SRI test environment', () => {
    const config = parseConfig({});

    expect(config.environment).toBe('local');
    expect(config.externalServices.sriProductionAllowed).toBe(false);
    expect(new URL(config.externalServices.sriEndpoints.test.receptionWsdl).host).toBe(
      'celcer.sri.gob.ec',
    );
    expect(config.kafka.brokers).toEqual(['localhost:29092']);
    expect(config.kafka.salesV1TenantId).toBeNull();
    expect(config.database).toEqual({
      url: 'postgres://faclab_invoicing:faclab_invoicing@localhost:5434/faclab_invoicing',
    });
    expect(config.http).toEqual({
      port: 3173,
      host: '0.0.0.0',
      corsOrigins: ['http://localhost:5173'],
    });
    expect(config.logger.level).toBe('debug');
    // faclab-infra's object-storage
    expect(config.objectStorage).toMatchObject({
      endpoint: 'http://localhost:3900',
      region: 'garage',
      bucket: 'faclab-invoicing',
      forcePathStyle: true,
    });
    expect(config.invoicing).toEqual({
      emissionDate: 'sale',
      finalConsumerMaxTotal: 50,
      providerRuc: null,
    });
  });

  it('takes the invoicing rules that may change (D-4) and the provider RUC', () => {
    const config = parseConfig({
      INVOICE_EMISSION_DATE: 'prepared',
      FINAL_CONSUMER_MAX_TOTAL: '200',
      INVOICING_PROVIDER_RUC: '1792141001001',
    });

    expect(config.invoicing).toEqual({
      emissionDate: 'prepared',
      finalConsumerMaxTotal: 200,
      providerRuc: '1792141001001',
    });
  });

  it('rejects an unknown emission date rule, a bad limit and a provider RUC of other length', () => {
    const message = errorOf({
      INVOICE_EMISSION_DATE: 'today',
      FINAL_CONSUMER_MAX_TOTAL: '-1',
      INVOICING_PROVIDER_RUC: '179214100',
    });

    expect(message).toContain('INVOICE_EMISSION_DATE must be one of: sale, prepared');
    expect(message).toContain('FINAL_CONSUMER_MAX_TOTAL');
    expect(message).toContain('INVOICING_PROVIDER_RUC must be a RUC of 13 digits');
  });

  it('runs the consumer and the worker in the API by default, four invoices at a time', () => {
    const config = parseConfig({});

    expect(config.runBackground).toBe(true);
    expect(config.invoiceQueue).toEqual({
      concurrency: 4,
      pollIntervalMs: 1000,
      lockTimeoutMs: 120_000,
    });
    expect(config.invoiceRecovery.intervalMs).toBe(60_000);
  });

  it('takes the worker settings, and leaves the background to the worker process', () => {
    const config = parseConfig({
      RUN_BACKGROUND: 'false',
      INVOICE_WORKER_CONCURRENCY: '2',
      INVOICE_POLL_INTERVAL_MS: '500',
      SRI_TIMEOUT_MS: '10000',
      SMTP_TIMEOUT_MS: '5000',
      INVOICE_LOCK_TIMEOUT_MS: '20000',
    });

    expect(config.runBackground).toBe(false);
    expect(config.invoiceQueue).toEqual({
      concurrency: 2,
      pollIntervalMs: 500,
      lockTimeoutMs: 20_000,
    });
  });

  it('refuses a lease an SRI call could outlast, and more slots than the pool holds', () => {
    expect(errorOf({ SRI_TIMEOUT_MS: '30000', INVOICE_LOCK_TIMEOUT_MS: '45000' })).toContain(
      'INVOICE_LOCK_TIMEOUT_MS must be at least 2 times SRI_TIMEOUT_MS',
    );
    expect(errorOf({ INVOICE_WORKER_CONCURRENCY: '9' })).toContain('INVOICE_WORKER_CONCURRENCY');
    expect(errorOf({ RUN_BACKGROUND: 'yes' })).toContain(
      'RUN_BACKGROUND must be one of: true, false',
    );
  });

  it('takes overrides, such as a container on faclab_network', () => {
    const config = parseConfig({
      KAFKA_BROKERS: ' kafka:9092 , ,other:9092,',
      DATABASE_URL:
        'postgres://faclab_invoicing:faclab_invoicing@invoicing-db:5432/faclab_invoicing',
      HTTP_PORT: '4000',
      CORS_ORIGINS: 'http://localhost:5173,http://localhost:8080',
      LOG_LEVEL: 'info',
    });

    expect(config.kafka.brokers).toEqual(['kafka:9092', 'other:9092']);
    expect(new URL(config.database.url).host).toBe('invoicing-db:5432');
    expect(config.http.port).toBe(4000);
    expect(config.http.corsOrigins).toEqual(['http://localhost:5173', 'http://localhost:8080']);
    expect(config.logger.level).toBe('info');
  });

  it('treats blank variables as unset', () => {
    expect(parseConfig({ NODE_ENV: '', KAFKA_BROKERS: '  ' }).kafka.brokers).toEqual([
      'localhost:29092',
    ]);
  });

  it('takes the default issuer of sales.confirmed v1', () => {
    const tenantId = '2B3C4D5E-6F70-4A8B-9C0D-1E2F3A4B5C6D';

    expect(parseConfig({ SALES_V1_TENANT_ID: tenantId }).kafka.salesV1TenantId).toBe(
      tenantId.toLowerCase(),
    );
    expect(errorOf({ SALES_V1_TENANT_ID: 'default' })).toContain('SALES_V1_TENANT_ID');
  });
});

describe('parseConfig: the delivery of invoices by email', () => {
  it("sends locally through faclab-infra's Mailpit", () => {
    expect(parseConfig({}).invoiceEmail).toEqual({
      enabled: true,
      from: 'facturas@faclab.local',
      smtp: {
        host: 'localhost',
        port: 1025,
        secure: false,
        requireTls: false,
        user: null,
        password: null,
        timeoutMs: 20_000,
      },
      concurrency: 2,
    });
  });

  it('needs STARTTLS in production unless TLS goes from the start', () => {
    expect(parseConfig(production()).invoiceEmail).toEqual({
      enabled: true,
      from: 'comprobantes@faclab.test',
      smtp: {
        host: 'smtp.provider.test',
        port: 587,
        secure: false,
        requireTls: true,
        user: 'faclab',
        password: SMTP_PASSWORD,
        timeoutMs: 20_000,
      },
      concurrency: 2,
    });
    const implicit = parseConfig(production({ SMTP_SECURE: 'true', SMTP_PORT: '465' }));
    expect(implicit.invoiceEmail.smtp).toMatchObject({
      secure: true,
      requireTls: false,
      port: 465,
    });
  });

  it('refuses to send without a mail server or a sender, unless sending is off', () => {
    const message = errorOf(production({ SMTP_HOST: undefined, INVOICE_EMAIL_FROM: '' }));
    expect(message).toContain('SMTP_HOST is required while INVOICE_EMAIL_ENABLED is true');
    expect(message).toContain('INVOICE_EMAIL_FROM is required while INVOICE_EMAIL_ENABLED is true');

    const off = parseConfig(
      production({ INVOICE_EMAIL_ENABLED: 'false', SMTP_HOST: undefined, INVOICE_EMAIL_FROM: '' }),
    );
    expect(off.invoiceEmail).toMatchObject({ enabled: false, from: null });
    expect(off.invoiceEmail.smtp.host).toBeNull();
  });

  it('refuses half the credentials and a sender that is not an address, without echoing them', () => {
    const message = errorOf(production({ SMTP_USER: undefined }));
    expect(message).toContain('SMTP_PASSWORD must be set together with SMTP_USER');
    expect(message).not.toContain(SMTP_PASSWORD);

    expect(errorOf(production({ INVOICE_EMAIL_FROM: 'Faclab' }))).toContain(
      'INVOICE_EMAIL_FROM must be an email address',
    );
  });

  it('keeps both workers within the database pool, and the lease longer than a slow server', () => {
    expect(
      errorOf(production({ INVOICE_WORKER_CONCURRENCY: '7', INVOICE_DELIVERY_CONCURRENCY: '2' })),
    ).toContain('INVOICE_DELIVERY_CONCURRENCY plus INVOICE_WORKER_CONCURRENCY must be at most 8');
    expect(
      errorOf(production({ SMTP_TIMEOUT_MS: '60000', INVOICE_LOCK_TIMEOUT_MS: '120000' })),
    ).toContain('INVOICE_LOCK_TIMEOUT_MS must be at least 3 times SMTP_TIMEOUT_MS');
  });
});

describe('parseConfig in production', () => {
  it('reaches both SRI environments: each issuer picks its own', () => {
    const config = parseConfig(production());

    expect(config.environment).toBe('production');
    expect(config.externalServices.sriProductionAllowed).toBe(true);
    expect(config.externalServices.sriEndpoints).toEqual({
      test: {
        receptionWsdl:
          'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline?wsdl',
        authorizationWsdl:
          'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl',
      },
      production: {
        receptionWsdl:
          'https://cel.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline?wsdl',
        authorizationWsdl:
          'https://cel.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl',
      },
    });
    expect(config.kafka.brokers).toEqual(['kafka-1:9092', 'kafka-2:9092']);
    expect(config.database).toEqual({ url: DATABASE_URL });
    expect(config.http.corsOrigins).toEqual(['https://app.faclab.test']);
    expect(config.auth).toEqual({ jwtSecret: JWT_SECRET, jwtIssuer: 'faclab-core' });
    expect(config.logger.level).toBe('info');
    expect(config.objectStorage).toEqual({
      endpoint: 'http://object-storage:3900',
      region: 'garage',
      bucket: 'faclab-invoicing',
      accessKeyId: 'GK0123456789abcdef0123456789abcdef',
      secretAccessKey: STORAGE_SECRET,
      forcePathStyle: true,
    });
  });

  it('takes AWS S3 itself when there is no endpoint', () => {
    const config = parseConfig(production({ OBJECT_STORAGE_ENDPOINT: undefined }));

    expect(config.objectStorage.endpoint).toBeNull();
  });

  it('refuses a storage endpoint that is not a URL', () => {
    expect(errorOf(production({ OBJECT_STORAGE_ENDPOINT: 'object-storage:3900' }))).toContain(
      'OBJECT_STORAGE_ENDPOINT must be an http:// or https:// URL',
    );
  });

  it('refuses to start without KAFKA_BROKERS or DATABASE_URL, naming both', () => {
    const message = errorOf(production({ DATABASE_URL: undefined, KAFKA_BROKERS: '' }));

    expect(message).toContain('NODE_ENV=production');
    expect(message).toContain('DATABASE_URL is required');
    expect(message).toContain('KAFKA_BROKERS is required');
  });

  it('refuses a default issuer for sales.confirmed v1', () => {
    expect(
      errorOf(production({ SALES_V1_TENANT_ID: '2b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c6d' })),
    ).toContain("SALES_V1_TENANT_ID can't be set in production");
  });

  it('has no default for anything that depends on where it runs', () => {
    const message = errorOf({ NODE_ENV: 'production' });

    for (const name of [
      'KAFKA_BROKERS',
      'DATABASE_URL',
      'CORS_ORIGINS',
      'JWT_SECRET',
      'CERTIFICATE_PASSWORD_KEY',
      'OBJECT_STORAGE_REGION',
      'OBJECT_STORAGE_BUCKET',
      'OBJECT_STORAGE_ACCESS_KEY_ID',
      'OBJECT_STORAGE_SECRET_ACCESS_KEY',
    ]) {
      expect(message).toContain(`${name} is required`);
    }
    // The secret never shows up in the error
    expect(errorOf(production({ OBJECT_STORAGE_BUCKET: '' }))).not.toContain(STORAGE_SECRET);
  });

  it('rejects a short JWT_SECRET and a bad CERTIFICATE_PASSWORD_KEY without echoing them', () => {
    const shortSecret = 'too-short-secret';
    const badKey = randomBytes(16).toString('base64');
    const message = errorOf(
      production({ JWT_SECRET: shortSecret, CERTIFICATE_PASSWORD_KEY: badKey }),
    );

    expect(message).toContain("JWT_SECRET must be faclab-core's secret (at least 32 characters)");
    expect(message).toContain('CERTIFICATE_PASSWORD_KEY must be 32 random bytes in base64');
    expect(message).not.toContain(shortSecret);
    expect(message).not.toContain(badKey);
  });

  it('rejects * in CORS_ORIGINS', () => {
    expect(errorOf(production({ CORS_ORIGINS: 'https://app.faclab.test,*' }))).toContain(
      "CORS_ORIGINS can't be * outside local",
    );
  });

  it('rejects invalid numbers', () => {
    const message = errorOf(production({ HTTP_PORT: 'abc', SRI_TIMEOUT_MS: '0' }));

    expect(message).toContain('HTTP_PORT');
    expect(message).toContain('SRI_TIMEOUT_MS');
  });

  it('rejects a DATABASE_URL that is not PostgreSQL without echoing it', () => {
    const url = 'mysql://faclab:s3cr3t-password@db:3306/faclab';
    const message = errorOf(production({ DATABASE_URL: url }));

    expect(message).toContain(
      'DATABASE_URL must be a postgres:// or postgresql:// connection string',
    );
    expect(message).not.toContain('s3cr3t-password');
  });
});

describe('parseConfig with another NODE_ENV', () => {
  it('fails instead of guessing', () => {
    expect(errorOf({ NODE_ENV: 'staging' })).toContain(
      'NODE_ENV must be one of: local, production',
    );
  });
});
