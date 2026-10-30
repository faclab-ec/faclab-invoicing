import { logger } from '#/shared/logger';

import { InvoiceRecoveryService } from '../app/services/invoice-recovery';

/**
 * Runs the invoice recovery on start and then every `intervalMs`, in the worker: the safety net for
 * invoices waiting for an issuer that became ready without this process hearing of it
 */
export class RecoveryScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly recovery: InvoiceRecoveryService,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    logger.info({ intervalMs: this.intervalMs }, 'Invoice recovery scheduled');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    this.recovery.run().catch((error) => logger.error({ err: error }, 'Invoice recovery failed'));
  }
}
