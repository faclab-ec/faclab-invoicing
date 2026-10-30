import { startHealthServer } from '#/shared/infra/worker-health';
import { initLogger, logger } from '#/shared/logger';
import { serviceNameFor } from '#/shared/telemetry/service-name';

import loadConfig, { ConfigError } from './config';
import { createContainer } from './container';
import { shutdownTelemetry } from './instrumentation';

// Flush the telemetry before leaving: process.exit drops whatever is still buffered
const exit = async (code: number): Promise<never> => {
  try {
    await shutdownTelemetry();
    logger.info('Telemetry flushed');
  } catch (error) {
    logger.error({ error }, 'Error flushing telemetry');
  }
  process.exit(code);
};

/**
 * The background of faclab-invoicing, apart from the API (ADR-0007): the consumer of
 * sales.confirmed, the worker that takes invoices from the queue in PostgreSQL and the recovery. Run
 * as many as needed: they never take the same invoice. Its /health is on HTTP_PORT.
 */
const main = async () => {
  const config = loadConfig();
  initLogger({
    level: config.logger.level,
    serviceName: serviceNameFor(process.argv, config.serviceName),
    serviceVersion: config.serviceVersion,
    environment: config.environment,
  });

  const container = createContainer(config);
  const background = container.createBackground();
  const healthServer = await startHealthServer(
    background.health,
    config.http.port,
    config.http.host,
  );
  await background.start();
  logger.info(
    { env: config.environment, concurrency: config.invoiceQueue.concurrency },
    'Worker started',
  );

  const shutdown = async () => {
    logger.info('Shutting down...');
    try {
      // No new sales, then the invoices in progress finish
      await background.stop();
      healthServer.close();
      await container.pool.end();
    } catch (error) {
      logger.error({ error }, 'Error during shutdown');
    }
    await exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

main().catch((error) => {
  if (error instanceof ConfigError) {
    // The logger is still silent: what failed is the configuration it needs
    console.error(error.message);
    return exit(1);
  }
  logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Worker error');
  return exit(1);
});
