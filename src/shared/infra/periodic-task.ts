import { logger } from '#/shared/logger';

export interface PeriodicTaskOptions {
  // In the logs: "Metrics sampling failed"
  name: string;
  intervalMs: number;
  run(): Promise<unknown>;
}

/**
 * Runs a task on start and then every `intervalMs`, one run at a time: a run still going when the
 * next is due skips it. A failed run is logged and the next one goes on. Its timer doesn't keep the
 * process alive.
 */
export class PeriodicTask {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly options: PeriodicTaskOptions) {}

  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.options.intervalMs);
    this.timer.unref();
  }

  /** No more runs; waits for the one in progress, which may be using the database */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  private tick(): void {
    if (this.running) return;
    this.running = this.options
      .run()
      .then(
        () => undefined,
        (error) => logger.error({ err: error }, `${this.options.name} failed`),
      )
      .finally(() => {
        this.running = null;
      });
  }
}

/**
 * Runs every sampler at once; one that fails is logged and doesn't stop the others (a missing
 * table, a slow query)
 */
export async function runSamplers(samplers: Record<string, () => Promise<void>>): Promise<void> {
  await Promise.all(
    Object.entries(samplers).map(([name, sample]) =>
      sample().catch((error) =>
        logger.warn({ err: error, sampler: name }, 'Sampling a metric failed'),
      ),
    ),
  );
}
