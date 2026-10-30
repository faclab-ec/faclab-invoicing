import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

import { logger } from '#/shared/logger';
import { contextFrom } from '#/shared/telemetry/trace-context';

import { InvoiceProcessor } from '../../app/services/invoice-processor';
import { ClaimedInvoice, InvoiceQueue } from '../../domain/queue';

export interface InvoiceWorkerOptions {
  // Invoices processed at the same time, each in a slot of its own
  concurrency: number;
  // How long an idle slot waits before looking for work again
  pollIntervalMs: number;
  // How long a slot holds an invoice before another may take it: longer than any single step
  leaseMs: number;
  // How long an invoice whose job broke (storage down) waits before the queue gives it out again
  errorBackoffMs: number;
  // This process in `locked_by`; each slot adds its number
  holder: string;
}

/** Told each time a slot finishes a cycle (WorkerHealth) */
export interface Heartbeat {
  beat(): void;
}

const tracer = trace.getTracer('faclab-invoicing.queue');

/**
 * Takes due invoices from the queue and runs their steps, `concurrency` at a time. Each slot holds
 * the invoice it runs (a lease), so two workers, in this process or another, never run the same
 * one; an invoice left by a worker that died is taken again once its lease runs out.
 */
export class InvoiceWorker {
  private slots: Promise<void>[] = [];
  private stopping = false;
  private readonly sleepers = new Set<() => void>();

  constructor(
    private readonly queue: InvoiceQueue,
    private readonly processor: InvoiceProcessor,
    private readonly options: InvoiceWorkerOptions,
    private readonly heartbeat: Heartbeat = { beat: () => undefined },
  ) {}

  start(): void {
    if (this.slots.length > 0) return;
    this.stopping = false;
    const { concurrency, pollIntervalMs, leaseMs, holder } = this.options;
    for (let slot = 1; slot <= concurrency; slot++) {
      this.slots.push(this.runSlot(`${holder}:${slot}`));
    }
    logger.info({ concurrency, pollIntervalMs, leaseMs }, 'Invoice worker started');
  }

  /** Takes no more invoices and waits for those in progress */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const wake of this.sleepers) wake();
    await Promise.all(this.slots);
    this.slots = [];
    logger.info('Invoice worker stopped');
  }

  private async runSlot(holder: string): Promise<void> {
    while (!this.stopping) {
      let busy = false;
      try {
        const [job] = await this.queue.claimDue(holder, this.options.leaseMs, 1);
        if (job) {
          busy = true;
          await this.runJob(job, holder);
        }
        this.heartbeat.beat();
      } catch (error) {
        // The database, most likely: wait before trying again
        logger.error({ err: error }, 'Taking invoices from the queue failed');
        busy = false;
      }
      if (!busy) await this.sleep(this.options.pollIntervalMs);
    }
  }

  private async runJob(job: ClaimedInvoice, holder: string): Promise<void> {
    // Continues the trace of the message that brought the sale
    const parent = contextFrom(job.traceContext);
    const span = tracer.startSpan(
      'process invoice',
      { kind: SpanKind.CONSUMER, attributes: { 'faclab.invoice.id': job.id } },
      parent,
    );
    const { leaseMs, errorBackoffMs } = this.options;
    try {
      await context.with(trace.setSpan(parent, span), () =>
        this.processor.run(job.id, { lease: { holder, leaseMs } }),
      );
    } catch (error) {
      // A failed step is recorded on the invoice: only storage errors get here. Not right away again
      const err = error instanceof Error ? error : new Error(String(error));
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      logger.error({ invoiceId: job.id, err }, 'Invoice job failed');
      await this.queue
        .postpone(job.id, new Date(Date.now() + errorBackoffMs))
        .catch((postponeError) => logger.error({ err: postponeError }, 'Postponing failed'));
    } finally {
      span.end();
      await this.queue
        .release(job.id, holder)
        .catch((releaseError) => logger.error({ err: releaseError }, 'Releasing failed'));
    }
  }

  // Cut short by stop()
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.sleepers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.sleepers.add(wake);
    });
  }
}
