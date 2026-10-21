import { SriEndpoints, SriEnvironment } from '#/config/sri';
import { Environment } from '#/modules/company-config/domain/company-config';
import { IssuerNotReadyError } from '#/modules/company-config/domain/readiness';
import { SoapClient } from '#/shared/infra/soap-client';

const SRI_ENVIRONMENT: Record<Environment, SriEnvironment> = {
  [Environment.TESTING]: 'test',
  [Environment.PRODUCTION]: 'production',
};

/**
 * The SRI web services of each environment, created on first use: each company's invoices go to
 * the environment of their issuer. Production is only reachable where it is allowed (NODE_ENV
 * production); readiness already keeps such issuers from invoicing elsewhere.
 */
export class SriClients {
  private readonly clients = new Map<string, SoapClient>();

  constructor(
    private readonly endpoints: Record<SriEnvironment, SriEndpoints>,
    private readonly timeoutMs: number,
    private readonly productionAllowed: boolean,
  ) {}

  reception(environment: Environment): SoapClient {
    return this.client(this.endpointsOf(environment).receptionWsdl);
  }

  authorization(environment: Environment): SoapClient {
    return this.client(this.endpointsOf(environment).authorizationWsdl);
  }

  private endpointsOf(environment: Environment): SriEndpoints {
    if (environment === Environment.PRODUCTION && !this.productionAllowed) {
      throw new IssuerNotReadyError(
        'ENVIRONMENT_NOT_ALLOWED',
        'This deployment only reaches the SRI test environment',
      );
    }
    return this.endpoints[SRI_ENVIRONMENT[environment]];
  }

  private client(wsdl: string): SoapClient {
    let client = this.clients.get(wsdl);
    if (!client) {
      client = new SoapClient(wsdl, this.timeoutMs);
      this.clients.set(wsdl, client);
    }
    return client;
  }
}
