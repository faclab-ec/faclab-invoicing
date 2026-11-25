import { parseArgs } from 'node:util';

import { resolveTenant } from '#/modules/data-protection/app/offboard-tenant';
import { DeadLetter, ReprocessResult } from '#/shared/infra/dead-letters';
import { initLogger, logger } from '#/shared/logger';

import loadConfig from './config';
import { Container, createContainer } from './container';

const USAGE = `Platform CLI of faclab-invoicing: the messages the consumer gave up on, of every company.

  npm run cli -- dead-letters [--limit N]
      The pending ones, oldest first (50 by default)
  npm run cli -- dead-letter-reprocess (--id N | --all) --by NAME
      Process one again, or every pending one, through the handler of its topic.
      --by is who does it: it stays on the row and in the log

Termination of a company's data (S8.7; docs/offboarding-runbook.md in faclab-core). The company is
named by its RUC; every step but the plan and the export takes --by.

  npm run cli -- tenant-export --ruc R --out DIR --by NAME
      A folder with CSVs, the fiscal profile and the authorized XML and RIDE of the company
  npm run cli -- tenant-offboard-plan --ruc R
      What anonymizing would do and what stays, writing nothing
  npm run cli -- tenant-offboard-start --ruc R --by NAME [--grace-days N] [--retention-ends YYYY-MM-DD]
  npm run cli -- tenant-offboard-cancel --ruc R --by NAME
  npm run cli -- tenant-anonymize --ruc R --by NAME [--execute] [--skip-grace]
      Without --execute it only shows the plan
  npm run cli -- tenant-purge --ruc R --by NAME --confirm-ruc R [--execute]
      After the tax retention; without --execute it only shows the plan`;

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
      ruc: { type: 'string' },
      out: { type: 'string' },
      'confirm-ruc': { type: 'string' },
      'grace-days': { type: 'string' },
      'retention-ends': { type: 'string' },
      execute: { type: 'boolean', default: false },
      'skip-grace': { type: 'boolean', default: false },
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

  if (command?.startsWith('tenant-')) return runTenantCommand(container, command, values);

  write(USAGE);
  return 2;
}

type Values = {
  ruc?: string;
  by?: string;
  out?: string;
  'confirm-ruc'?: string;
  'grace-days'?: string;
  'retention-ends'?: string;
  execute: boolean;
  'skip-grace': boolean;
};

const show = (value: unknown) => write(JSON.stringify(value, null, 2));

async function runTenantCommand(
  container: Container,
  command: string,
  values: Values,
): Promise<number> {
  const { repository, exportData, offboarding } = container.tenantData;
  const needsBy = command !== 'tenant-offboard-plan';
  if (!values.ruc || (needsBy && !values.by)) {
    write(USAGE);
    return 2;
  }
  const tenantId = await resolveTenant(repository, values.ruc);
  const by = values.by ?? '';

  if (command === 'tenant-export') {
    if (!values.out) {
      write(USAGE);
      return 2;
    }
    const result = await exportData.execute(tenantId, values.out, by);
    show(result);
    return result.failed.length === 0 ? 0 : 1;
  }
  if (command === 'tenant-offboard-plan') {
    show(await offboarding.plan(tenantId));
    return 0;
  }
  if (command === 'tenant-offboard-start') {
    show(
      await offboarding.start(tenantId, {
        by,
        graceDays: values['grace-days'] ? Number(values['grace-days']) : undefined,
        retentionEndsAt: values['retention-ends'] ? new Date(values['retention-ends']) : undefined,
      }),
    );
    return 0;
  }
  if (command === 'tenant-offboard-cancel') {
    await offboarding.cancel(tenantId);
    write('Offboarding taken back');
    return 0;
  }
  if (command === 'tenant-anonymize') {
    if (!values.execute) {
      show(await offboarding.plan(tenantId));
      return 0;
    }
    show(await offboarding.anonymize(tenantId, { by, skipGrace: values['skip-grace'] }));
    return 0;
  }
  if (command === 'tenant-purge') {
    if (!values['confirm-ruc']) {
      write(USAGE);
      return 2;
    }
    if (!values.execute) {
      show(await offboarding.plan(tenantId));
      return 0;
    }
    show(await offboarding.purge(tenantId, { by, confirmRuc: values['confirm-ruc'] }));
    return 0;
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
