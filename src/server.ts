import { initLogger, logger } from '#/shared/logger';

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

const main = async () => {
  const config = loadConfig();
  initLogger({
    level: config.logger.level,
    serviceName: config.serviceName,
    serviceVersion: config.serviceVersion,
    environment: config.environment,
  });

  // Each issuer picks its SRI environment; only production may reach the one with tax validity
  const { sriProductionAllowed } = config.externalServices;
  logger.info(
    { sriEnvironments: sriProductionAllowed ? ['test', 'production'] : ['test'] },
    'SRI environments',
  );
  if (config.kafka.salesV1TenantId) {
    logger.warn(
      { tenantId: config.kafka.salesV1TenantId },
      'sales.confirmed v1 is invoiced by the company in SALES_V1_TENANT_ID',
    );
  }

  const { consumer, producer, httpServer, recoveryScheduler, pool } = await createContainer(config);
  await consumer.start();
  recoveryScheduler.start();
  await httpServer.listen({ port: config.http.port, host: config.http.host });
  logger.info({ env: config.environment, port: config.http.port }, 'Application started');

  const shutdown = async () => {
    logger.info('Shutting down...');
    try {
      recoveryScheduler.stop();
      await consumer.stop();
      await producer.disconnect();
      await httpServer.close();
      // Last: the steps above may still be saving invoices
      await pool.end();
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
  logger.error(
    { error: error instanceof Error ? error.message : String(error) },
    'Application error',
  );
  return exit(1);
});
