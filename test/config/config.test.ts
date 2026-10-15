import { randomBytes } from 'crypto';
import { describe, expect, it } from 'vitest';

import { ConfigError, parseConfig } from '#/config';

const JWT_SECRET = randomBytes(32).toString('hex');
const CERTIFICATE_PASSWORD_KEY = randomBytes(32).toString('base64');

const production = (overrides: Record<string, string | undefined> = {}) => ({
  NODE_ENV: 'production',
  SRI_ENVIRONMENT: 'production',
  KAFKA_BROKERS: 'kafka-1:9092,kafka-2:9092',
  AWS_REGION: 'us-east-2',
  DYNAMODB_INVOICES_TABLE: 'prod_invoices',
  DYNAMODB_CERTIFICATES_TABLE: 'prod_certificates',
  DYNAMODB_COMPANY_CONFIG_TABLE: 'prod_company_config',
  S3_CERTIFICATES_BUCKET: 'prod-certificates',
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
  it('defaults to local with the faclab-infra services and the SRI test environment', () => {
    const config = parseConfig({});

    expect(config.environment).toBe('local');
    expect(config.externalServices.sriEnvironment).toBe('test');
    expect(new URL(config.externalServices.sriVoucherWsdl).host).toBe('celcer.sri.gob.ec');
    expect(new URL(config.externalServices.sriQueryWsdl).host).toBe('celcer.sri.gob.ec');
    expect(config.kafka.brokers).toEqual(['localhost:29092']);
    expect(config.aws).toEqual({
      region: 'us-east-1',
      endpoint: 'http://localhost:4566',
      dynamoDb: {
        tables: {
          invoices: 'invoices',
          certificates: 'certificates',
          companyConfig: 'company_config',
        },
      },
      s3: { bucket: 'faclab-invoicing-certificates' },
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
      AWS_ENDPOINT_URL: 'http://aws-local:4566',
      DYNAMODB_INVOICES_TABLE: 'my_invoices',
      HTTP_PORT: '4000',
      CORS_ORIGINS: 'http://localhost:5173,http://localhost:8080',
      LOG_LEVEL: 'info',
    });

    expect(config.kafka.brokers).toEqual(['kafka:9092', 'other:9092']);
    expect(config.aws.endpoint).toBe('http://aws-local:4566');
    expect(config.aws.dynamoDb.tables.invoices).toBe('my_invoices');
    expect(config.http.port).toBe(4000);
    expect(config.http.corsOrigins).toEqual(['http://localhost:5173', 'http://localhost:8080']);
    expect(config.logger.level).toBe('info');
  });

  it('treats blank variables as unset', () => {
    expect(parseConfig({ NODE_ENV: '', KAFKA_BROKERS: '  ' }).kafka.brokers).toEqual([
      'localhost:29092',
    ]);
  });

  it('refuses the SRI production environment', () => {
    expect(errorOf({ SRI_ENVIRONMENT: 'production' })).toContain(
      'SRI_ENVIRONMENT must be test outside production',
    );
  });
});

describe('parseConfig in production', () => {
  it('uses the SRI environment with tax validity when asked to', () => {
    const config = parseConfig(production());

    expect(config.environment).toBe('production');
    expect(config.externalServices.sriEnvironment).toBe('production');
    expect(config.externalServices.sriVoucherWsdl).toBe(
      'https://cel.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline?wsdl',
    );
    expect(config.externalServices.sriQueryWsdl).toBe(
      'https://cel.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl',
    );
    expect(config.kafka.brokers).toEqual(['kafka-1:9092', 'kafka-2:9092']);
    expect(config.aws).toEqual({
      region: 'us-east-2',
      endpoint: undefined,
      dynamoDb: {
        tables: {
          invoices: 'prod_invoices',
          certificates: 'prod_certificates',
          companyConfig: 'prod_company_config',
        },
      },
      s3: { bucket: 'prod-certificates' },
    });
    expect(config.http.corsOrigins).toEqual(['https://app.faclab.test']);
    expect(config.auth).toEqual({ jwtSecret: JWT_SECRET, jwtIssuer: 'faclab-core' });
    expect(config.logger.level).toBe('info');
  });

  it('uses the SRI test environment when set explicitly', () => {
    const config = parseConfig(production({ SRI_ENVIRONMENT: 'test' }));

    expect(config.externalServices.sriEnvironment).toBe('test');
    expect(config.externalServices.sriVoucherWsdl).toBe(
      'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline?wsdl',
    );
    expect(config.externalServices.sriQueryWsdl).toBe(
      'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl',
    );
  });

  it('refuses to start without SRI_ENVIRONMENT or KAFKA_BROKERS, naming both', () => {
    const message = errorOf(production({ SRI_ENVIRONMENT: undefined, KAFKA_BROKERS: '' }));

    expect(message).toContain('NODE_ENV=production');
    expect(message).toContain('SRI_ENVIRONMENT is required');
    expect(message).toContain('KAFKA_BROKERS is required');
  });

  it('has no default for anything that depends on where it runs', () => {
    const message = errorOf({ NODE_ENV: 'production' });

    for (const name of [
      'SRI_ENVIRONMENT',
      'KAFKA_BROKERS',
      'AWS_REGION',
      'DYNAMODB_INVOICES_TABLE',
      'DYNAMODB_CERTIFICATES_TABLE',
      'DYNAMODB_COMPANY_CONFIG_TABLE',
      'S3_CERTIFICATES_BUCKET',
      'CORS_ORIGINS',
      'JWT_SECRET',
      'CERTIFICATE_PASSWORD_KEY',
    ]) {
      expect(message).toContain(`${name} is required`);
    }
  });

  it('rejects an unknown SRI environment without echoing it', () => {
    const message = errorOf(production({ SRI_ENVIRONMENT: 'prod' }));

    expect(message).toContain('SRI_ENVIRONMENT must be one of: test, production');
    expect(message).not.toContain('received');
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

  it('rejects invalid numbers and URLs', () => {
    const message = errorOf(
      production({ HTTP_PORT: 'abc', SRI_TIMEOUT_MS: '0', AWS_ENDPOINT_URL: 'not a url' }),
    );

    expect(message).toContain('HTTP_PORT');
    expect(message).toContain('SRI_TIMEOUT_MS');
    expect(message).toContain('AWS_ENDPOINT_URL must be a URL');
  });
});

describe('parseConfig with another NODE_ENV', () => {
  it('fails instead of guessing', () => {
    expect(errorOf({ NODE_ENV: 'staging' })).toContain(
      'NODE_ENV must be one of: local, production',
    );
  });
});
