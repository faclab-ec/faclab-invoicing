import { randomBytes } from 'crypto';
import { describe, expect, it } from 'vitest';

import { ConfigError, parseConfig } from '#/config';

const JWT_SECRET = randomBytes(32).toString('hex');
const CERTIFICATE_PASSWORD_KEY = randomBytes(32).toString('base64');
const DATABASE_URL = `postgres://faclab_invoicing:${randomBytes(8).toString('hex')}@db:5432/faclab_invoicing`;

const production = (overrides: Record<string, string | undefined> = {}) => ({
  NODE_ENV: 'production',
  KAFKA_BROKERS: 'kafka-1:9092,kafka-2:9092',
  DATABASE_URL,
  CORS_ORIGINS: 'https://app.faclab.test',
  JWT_SECRET,
  CERTIFICATE_PASSWORD_KEY,
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
    ]) {
      expect(message).toContain(`${name} is required`);
    }
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
