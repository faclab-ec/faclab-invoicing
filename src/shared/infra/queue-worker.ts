import { Attributes, context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

import { logger } from '#/shared/logger';
import { contextFrom, TraceCarrier } from '#/shared/telemetry/trace-context';

/** A row a worker took from a queue table */
export interface QueuedJob {
  id: string;
  // The trace its job continues
  traceContext: TraceCarrier | null;
}

/** What a worker needs from a queue table (`FOR UPDATE SKIP LOCKED`, leases) */
export interface JobQueue<J extends QueuedJob> {
  /** Takes up to `limit` due rows nobody holds, oldest due first */
  claimDue(holder: string, leaseMs: number, limit: number): Promise<J[]>;
  /** Lets the row go, if the holder still has it */
  release(id: string, holder: string): Promise<void>;
  /** When the queue gives the row out again */
  postpone(id: string, at: Date): Promise<void>;
}

export interface QueueWorkerOptions {
  // Jobs run at the same time, each in a slot of its own
  concurrency: number;
  // How long an idle slot waits before looking for work again
  pollIntervalMs: number;
  // How long a slot holds a job before another may take it: longer than any single run
  leaseMs: number;
  // How long a job whose run broke (storage down) waits before the queue gives it out again
  errorBackoffMs: number;
  // This process in `locked_by`; each slot adds its number
  holder: string;
}

/** How a worker shows up in its logs and spans */
export interface QueueWorkerDescription<J> {
  // In the logs: "Invoice worker started"
  name: string;
  // The CONSUMER span of each job
  spanName: string;
  attributes(job: J): Attributes;
  logFields(job: J): Record<string, unknown>;
}

export interface Lease {
  holder: string;
  leaseMs: number;
}

/** Told each time a slot finishes a cycle (WorkerHealth) */
export interface Heartbeat {
  beat(): void;
}

const tracer = trace.getTracer('faclab-invoicing.queue');

/**
 * Takes due jobs from a queue table and runs them, `concurrency` at a time. Each slot holds the job
 * it runs (a lease), so two workers, in this process or another, never run the same one; a job left
 * by a worker that died is taken again once its lease runs out.
 */
export class QueueWorker<J extends QueuedJob> {
  private slots: Promise<void>[] = [];
  private stopping = false;
  private readonly sleepers = new Set<() => void>();

  constructor(
    private readonly queue: JobQueue<J>,
    private readonly run: (job: J, lease: Lease) => Promise<unknown>,
    private readonly description: QueueWorkerDescription<J>,
    private readonly options: QueueWorkerOptions,
    private readonly heartbeat: Heartbeat = { beat: () => undefined },
  ) {}

  start(): void {
    if (this.slots.length > 0) return;
    this.stopping = false;
    const { concurrency, pollIntervalMs, leaseMs, holder } = this.options;
    for (let slot = 1; slot <= concurrency; slot++) {
      this.slots.push(this.runSlot(`${holder}:${slot}`));
    }
    logger.info({ concurrency, pollIntervalMs, leaseMs }, `${this.description.name} started`);
  }

  /** Takes no more jobs and waits for those in progress */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const wake of this.sleepers) wake();
    await Promise.all(this.slots);
    this.slots = [];
    logger.info(`${this.description.name} stopped`);
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
        logger.error({ err: error }, `${this.description.name}: taking from the queue failed`);
        busy = false;
      }
      if (!busy) await this.sleep(this.options.pollIntervalMs);
    }
  }

  private async runJob(job: J, holder: string): Promise<void> {
    // Continues the trace stored with the job
    const parent = contextFrom(job.traceContext);
    const span = tracer.startSpan(
      this.description.spanName,
      { kind: SpanKind.CONSUMER, attributes: this.description.attributes(job) },
      parent,
    );
    const { leaseMs, errorBackoffMs } = this.options;
    try {
      await context.with(trace.setSpan(parent, span), () => this.run(job, { holder, leaseMs }));
    } catch (error) {
      // A failed run is recorded on its row: only storage errors get here. Not right away again
      const err = error instanceof Error ? error : new Error(String(error));
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      logger.error(
        { ...this.description.logFields(job), err },
        `${this.description.name}: job failed`,
      );
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
