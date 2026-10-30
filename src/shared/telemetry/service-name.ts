// The worker entry: dist/worker.js once built, src/worker.ts with ts-node-dev
const WORKER_ENTRY = /(^|[\\/])worker\.(js|ts)$/;

/**
 * service.name of this process: OTEL_SERVICE_NAME (faclab-invoicing by default), and
 * `<name>-worker` for the worker, like faclab-core's
 */
export function serviceNameFor(argv: string[], baseName = 'faclab-invoicing'): string {
  return argv.some((arg) => WORKER_ENTRY.test(arg)) ? `${baseName}-worker` : baseName;
}
