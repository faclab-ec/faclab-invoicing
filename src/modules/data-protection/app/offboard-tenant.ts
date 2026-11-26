import { DocumentStorage } from '#/modules/invoice/domain/ports';
import { ConflictError, NotFoundError } from '#/shared/errors/app-error';
import { logger } from '#/shared/logger';

import {
  CountsByTable,
  OffboardingPlan,
  OffboardingState,
  PgTenantDataRepository,
} from '../infra/pg-tenant-data.repository';

export const DEFAULT_GRACE_DAYS = 30;
export const DEFAULT_RETENTION_YEARS = 7;

export interface StartOptions {
  by: string;
  graceDays?: number;
  retentionYears?: number;
  /** faclab-core's `retentionEndsAt`, so both services agree on the date */
  retentionEndsAt?: Date;
  now?: Date;
}

export interface AnonymizeOptions {
  by: string;
  /** Only for a test company that must not wait for its grace period */
  skipGrace?: boolean;
  now?: Date;
}

export interface PurgeOptions {
  by: string;
  confirmRuc: string;
  now?: Date;
}

function addYears(date: Date, years: number): Date {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCFullYear(result.getUTCFullYear() + years);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

/**
 * The termination of a company's contract in this service (S8.7), in the same three steps as
 * faclab-core: start (a grace period; the retention of what tax law makes us keep is calculated
 * from the last document), anonymize (after the grace period) and purge (after the retention).
 * The signed XML and the RIDE are the legal record of each document: they are never edited.
 */
export class OffboardTenant {
  constructor(
    private readonly data: PgTenantDataRepository,
    private readonly storage: DocumentStorage,
  ) {}

  async plan(tenantId: string): Promise<{ state: OffboardingState | null } & OffboardingPlan> {
    return { state: await this.data.offboarding(tenantId), ...(await this.data.plan(tenantId)) };
  }

  async start(tenantId: string, options: StartOptions): Promise<OffboardingState> {
    const now = options.now ?? new Date();
    const last = (await this.data.lastDocumentAt(tenantId)) ?? now;
    const graceEndsAt = new Date(
      now.getTime() + (options.graceDays ?? DEFAULT_GRACE_DAYS) * 24 * 60 * 60 * 1000,
    );
    const retentionEndsAt =
      options.retentionEndsAt ?? addYears(last, options.retentionYears ?? DEFAULT_RETENTION_YEARS);
    if (!(await this.data.start(tenantId, options.by, graceEndsAt, retentionEndsAt))) {
      throw new ConflictError('OFFBOARDING_ALREADY_STARTED', 'The offboarding already started');
    }
    logger.info(
      { event: 'tenant.offboarding.started', by: options.by },
      'Tenant offboarding started',
    );
    return (await this.data.offboarding(tenantId))!;
  }

  async cancel(tenantId: string): Promise<void> {
    if (!(await this.data.cancel(tenantId))) {
      throw new ConflictError(
        'OFFBOARDING_NOT_CANCELLABLE',
        'There is no offboarding to take back, or the company was already anonymized',
      );
    }
    logger.info({ event: 'tenant.offboarding.cancelled' }, 'Tenant offboarding cancelled');
  }

  async anonymize(tenantId: string, options: AnonymizeOptions): Promise<CountsByTable> {
    const now = options.now ?? new Date();
    const state = await this.require(tenantId);
    if (state.anonymizedAt) {
      throw new ConflictError('OFFBOARDING_STEP_INVALID', 'The company is already anonymized');
    }
    if (state.graceEndsAt > now && !options.skipGrace) {
      throw new ConflictError(
        'OFFBOARDING_GRACE_NOT_ENDED',
        `The grace period ends at ${state.graceEndsAt.toISOString()}`,
      );
    }
    const inFlight = await this.data.inFlight(tenantId);
    if (inFlight > 0) {
      throw new ConflictError(
        'OFFBOARDING_PENDING_DOCUMENTS',
        `${inFlight} document(s) or delivery(ies) are still in the queue`,
      );
    }
    const { counts, logoKey } = await this.data.anonymize(tenantId, options.by);
    // After the commit: the logo is the issuer's, not a document
    if (logoKey) await this.storage.delete(logoKey);
    logger.info({ event: 'tenant.anonymized', by: options.by, counts }, 'Tenant data anonymized');
    return counts;
  }

  async purge(tenantId: string, options: PurgeOptions): Promise<CountsByTable> {
    const now = options.now ?? new Date();
    const state = await this.require(tenantId);
    if (!state.anonymizedAt) {
      throw new ConflictError('OFFBOARDING_STEP_INVALID', 'Anonymize the company first');
    }
    if (state.purgedAt) {
      throw new ConflictError('OFFBOARDING_STEP_INVALID', 'The company was already purged');
    }
    if ((await this.data.rucOf(tenantId)) !== options.confirmRuc.trim()) {
      throw new ConflictError('OFFBOARDING_STEP_INVALID', 'The RUC typed is not the company’s');
    }
    if (state.retentionEndsAt > now) {
      throw new ConflictError(
        'OFFBOARDING_RETENTION_NOT_ENDED',
        `The tax retention ends at ${state.retentionEndsAt.toISOString()}`,
      );
    }
    const counts = await this.data.purge(tenantId, options.by);
    // The company's folder: with Object Lock (compliance) a delete only adds a marker and the
    // locked versions stay until their own date (docs/data-protection.md in faclab-core)
    const keys = await this.storage.list(`tenants/${tenantId}/`);
    for (const key of keys) await this.storage.delete(key);
    counts.objects = keys.length;
    logger.warn({ event: 'tenant.purged', by: options.by, counts }, 'Tenant data purged');
    return counts;
  }

  private async require(tenantId: string): Promise<OffboardingState> {
    const state = await this.data.offboarding(tenantId);
    if (!state) throw new ConflictError('OFFBOARDING_STEP_INVALID', 'Start the offboarding first');
    return state;
  }
}

export async function resolveTenant(data: PgTenantDataRepository, ruc: string): Promise<string> {
  const tenantId = await data.findTenantByRuc(ruc);
  if (!tenantId) throw new NotFoundError(`No company with RUC ${ruc} in this service`);
  return tenantId;
}
