import { afterEach, describe, expect, it } from 'vitest';

import { startHealthServer, WorkerHealth } from '#/shared/infra/worker-health';
import { serviceNameFor } from '#/shared/telemetry/service-name';

describe('WorkerHealth', () => {
  let now = 0;
  const health = () => new WorkerHealth(1_000, () => now);
  let server: Awaited<ReturnType<typeof startHealthServer>> | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it('stalls once no cycle finished within its time, and recovers with the next one', () => {
    now = 0;
    const worker = health();
    now = 1_000;
    expect(worker.healthy).toBe(true);

    now = 1_001;
    expect(worker.healthy).toBe(false);

    worker.beat();
    expect(worker.healthy).toBe(true);
  });

  it('answers /health with 200 or 503, like the image HEALTHCHECK expects', async () => {
    now = 0;
    const worker = health();
    server = await startHealthServer(worker, 0, '127.0.0.1');
    const { port } = server.address() as { port: number };
    const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`);

    const ok = await get('/health');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: 'ok' });

    now = 5_000;
    const stalled = await get('/health');
    expect(stalled.status).toBe(503);
    expect(await stalled.json()).toEqual({ status: 'stalled' });

    expect((await get('/docs')).status).toBe(404);
  });
});

describe('serviceNameFor', () => {
  it('names the worker process <name>-worker, built or with ts-node-dev', () => {
    expect(serviceNameFor(['node', '/app/dist/server.js'])).toBe('faclab-invoicing');
    expect(serviceNameFor(['node', '/app/dist/worker.js'])).toBe('faclab-invoicing-worker');
    expect(serviceNameFor(['node', 'bin.js', '-r', 'x', 'src/worker.ts'], 'invoicing')).toBe(
      'invoicing-worker',
    );
  });
});
