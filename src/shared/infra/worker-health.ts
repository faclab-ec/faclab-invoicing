import { createServer, Server } from 'node:http';

/** Whether a part of the worker is still doing its cycles */
export interface HealthCheck {
  readonly healthy: boolean;
}

/** Healthy while every part is: a stalled one makes the whole worker stalled */
export function allHealthy(...checks: HealthCheck[]): HealthCheck {
  return {
    get healthy() {
      return checks.every((check) => check.healthy);
    },
  };
}

/** When the worker last finished a cycle: stalled once that is longer ago than `maxAgeMs` */
export class WorkerHealth implements HealthCheck {
  private lastBeat: number;

  constructor(
    private readonly maxAgeMs: number,
    private readonly now: () => number = Date.now,
  ) {
    // Starting counts as the first cycle
    this.lastBeat = now();
  }

  beat(): void {
    this.lastBeat = this.now();
  }

  get healthy(): boolean {
    return this.now() - this.lastBeat <= this.maxAgeMs;
  }
}

/**
 * The worker's `/health`, on HTTP_PORT like the API's, so the image's HEALTHCHECK serves both
 * commands: 200 while its cycles keep finishing, 503 once they stall
 */
export async function startHealthServer(
  health: HealthCheck,
  port: number,
  host: string,
): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/health') {
      response.writeHead(404).end();
      return;
    }
    const { healthy } = health;
    response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: healthy ? 'ok' : 'stalled' }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  return server;
}
