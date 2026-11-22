import pino from 'pino';

import { initLogger } from '#/shared/logger';

export type LogLine = Record<string, unknown>;

export interface CapturedLogs {
  /** The lines written so far, parsed */
  (): LogLine[];
  /** The lines as they were written */
  raw: string[];
  log: pino.Logger;
}

/**
 * Logs as the service writes them outside local (JSON lines, with the redaction and the trace
 * fields), kept in memory. It replaces the shared logger: call `silenceLogs` after each test.
 */
export function captureLogs({
  level = 'info',
  serviceVersion = 'test',
}: { level?: string; serviceVersion?: string } = {}): CapturedLogs {
  const raw: string[] = [];
  const log = initLogger(
    { level, serviceName: 'faclab-invoicing', serviceVersion, environment: 'production' },
    { write: (line: string) => raw.push(line) },
  );
  const read = () => raw.map((line) => JSON.parse(line) as LogLine);
  return Object.assign(read, { raw, log });
}

/** The shared logger back to silent, as the tests start */
export function silenceLogs() {
  initLogger(
    {
      level: 'silent',
      serviceName: 'faclab-invoicing',
      serviceVersion: 'test',
      environment: 'production',
    },
    { write: () => undefined },
  );
}
