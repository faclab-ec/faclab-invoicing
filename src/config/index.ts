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
    sriVoucherWsdl: string;
    sriQueryWsdl: string;
  };
  signing: {
    p12Password: string;
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
  environment: string;
}

const env = process.env.NODE_ENV || 'local';
async function loadConfig(): Promise<AppConfig> {
  const configModule = await import(`./${env.toLowerCase()}`);
  return configModule.default as AppConfig;
}

export default loadConfig;
