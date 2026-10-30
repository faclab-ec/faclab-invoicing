import { parseArgs } from 'node:util';

import { DeadLetter, ReprocessResult } from '#/shared/infra/dead-letters';
import { initLogger, logger } from '#/shared/logger';

import loadConfig from './config';
import { Container, createContainer } from './container';

const USAGE = `Platform CLI of faclab-invoicing: the messages the consumer gave up on, of every company.

  npm run cli -- dead-letters [--limit N]
      The pending ones, oldest first (50 by default)
  npm run cli -- dead-letter-reprocess (--id N | --all) --by NAME
      Process one again, or every pending one, through the handler of its topic.
      --by is who does it: it stays on the row and in the log`;

const write = (line: string) => process.stdout.write(`${line}\n`);

function describe(letter: DeadLetter): string {
  const from = `${letter.topic}[${letter.partition}]@${letter.offset}`;
  const lastTry = letter.reprocessError ? ` | last reprocess: ${letter.reprocessError}` : '';
  return (
    `${letter.id}  ${letter.createdAt.toISOString()}  ${from}  tenant=${letter.tenantId ?? '-'}` +
    `  ${letter.errorType} x${letter.attempts}: ${letter.error}${lastTry}`
  );
}

function report(result: ReprocessResult): void {
  write(
    result.reprocessed
      ? `Dead letter ${result.id} reprocessed`
      : `Dead letter ${result.id} not reprocessed: ${result.error}`,
  );
}

async function run(container: Container, argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      limit: { type: 'string', default: '50' },
      id: { type: 'string' },
      all: { type: 'boolean', default: false },
      by: { type: 'string' },
    },
  });
  const [command] = positionals;

  if (command === 'dead-letters') {
    const letters = await container.deadLetters.pending(Number(values.limit));
    letters.forEach((letter) => write(describe(letter)));
    write(`${letters.length} pending dead letter(s)`);
    return 0;
  }

  if (command === 'dead-letter-reprocess') {
    if (!values.by || (values.id === undefined) === !values.all) {
      write(USAGE);
      return 2;
    }
    const reprocessor = container.createDeadLetterReprocessor();
    const results = values.all
      ? await reprocessor.reprocessAll(values.by)
      : [await reprocessor.reprocess(Number(values.id), values.by)];
    results.forEach(report);
    return results.every((result) => result.reprocessed) ? 0 : 1;
  }

  write(USAGE);
  return 2;
}

const main = async () => {
  const config = loadConfig();
  initLogger({
    level: config.logger.level,
    serviceName: `${config.serviceName}-cli`,
    serviceVersion: config.serviceVersion,
    environment: config.environment,
  });
  const container = createContainer(config);
  try {
    process.exitCode = await run(container, process.argv.slice(2));
  } catch (error) {
    logger.error({ err: error }, 'CLI failed');
    process.exitCode = 1;
  } finally {
    await container.pool.end();
  }
};

void main();
