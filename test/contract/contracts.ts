import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Copy of faclab-core's contracts, pinned in contracts/source.json (npm run contracts:sync)
const EVENTS = resolve(__dirname, '../../contracts/events');

function load(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadSchema(topic: string, version = 1): object {
  return load(join(EVENTS, topic, `v${version}.schema.json`)) as object;
}

/** Example messages of a topic, by file name without extension */
export function loadExamples(topic: string): Record<string, Record<string, unknown>> {
  const dir = join(EVENTS, topic, 'examples');
  return Object.fromEntries(
    readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file) => [file.replace(/\.json$/, ''), load(join(dir, file))]),
  ) as Record<string, Record<string, unknown>>;
}
