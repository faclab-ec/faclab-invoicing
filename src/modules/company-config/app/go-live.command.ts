import { InvoiceStatus } from '#/modules/invoice/domain/invoice';
import { InvoiceRepository } from '#/modules/invoice/domain/repository';
import { ConflictError, UnprocessableError } from '#/shared/errors/app-error';
import { logger } from '#/shared/logger';

import { CompanyConfig, Environment } from '../domain/company-config';
import { ProductionActor } from '../domain/production';
import { IssuerProductionRepository } from '../domain/production';
import { IssuerChangeListener } from '../domain/readiness';
import { CompanyConfigRepository } from '../domain/repository';
import { IssuerReadinessService } from './issuer-readiness';

export interface GoLiveInput {
  // The RUC of the company typed again: the confirmation
  confirmRuc: string;
  acknowledge: boolean;
}

/**
 * The only way to move a company's issuer from the SRI's test environment to production (S8.5):
 * `PUT /api/company-config` refuses it. It asks for the company's RUC again, a ready issuer and an
 * authorized test invoice, and it is audited (`issuer_audit`). There is no way back from here.
 */
export class GoLiveCommand {
  constructor(
    private readonly configRepository: CompanyConfigRepository,
    private readonly readiness: IssuerReadinessService,
    private readonly invoices: InvoiceRepository,
    private readonly production: IssuerProductionRepository,
    private readonly issuerListener: IssuerChangeListener,
    private readonly productionAllowed: boolean,
  ) {}

  async execute(
    tenantId: string,
    input: GoLiveInput,
    actor: ProductionActor,
  ): Promise<CompanyConfig> {
    const config = await this.configRepository.find(tenantId);
    if (!config) {
      throw new ConflictError('ISSUER_NOT_CONFIGURED', 'Save the fiscal profile first');
    }
    if (config.environment === Environment.PRODUCTION) {
      throw new ConflictError('ALREADY_IN_PRODUCTION', 'The company already issues in production');
    }
    if (!input.acknowledge || input.confirmRuc.trim() !== config.taxId) {
      throw new UnprocessableError(
        'CONFIRMATION_MISMATCH',
        'Type the company RUC and accept to go to production',
      );
    }
    if (!this.productionAllowed) {
      throw new ConflictError(
        'ENVIRONMENT_NOT_ALLOWED',
        'This deployment can only reach the SRI test environment',
      );
    }
    const report = await this.readiness.check(tenantId);
    const blocking = report.issues.find((issue) => issue.severity === 'error');
    if (!report.ready || blocking) {
      throw new ConflictError(
        'ISSUER_NOT_READY',
        blocking?.message ?? 'The issuer is not ready to invoice',
      );
    }
    const test = await this.invoices.findOnboardingTest(tenantId);
    if (!test || test.status !== InvoiceStatus.AUTHORIZED) {
      throw new ConflictError(
        'TEST_INVOICE_REQUIRED',
        'Issue a test invoice and wait for the SRI to authorize it before going to production',
      );
    }

    const result = await this.production.enterProduction(tenantId, actor);
    if (!result) {
      // Someone else did it between the checks and the transaction
      throw new ConflictError('ALREADY_IN_PRODUCTION', 'The company already issues in production');
    }
    this.issuerListener.issuerChanged(tenantId);
    logger.warn(
      { 'event.name': 'issuer.production_enabled', tenantId, actor: actor.username, ...result },
      'Company moved to the SRI production environment',
    );
    const updated = await this.configRepository.find(tenantId);
    return updated ?? config;
  }
}
