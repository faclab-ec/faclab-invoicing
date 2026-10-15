import { initLogger, logger } from '#/shared/logger';

import loadConfig, { ConfigError } from './config';
import { createContainer } from './container';

const main = async () => {
  const config = loadConfig();
  initLogger({
    level: config.logger.level,
    serviceName: config.serviceName,
    environment: config.environment,
  });

  const { sriEnvironment, sriVoucherWsdl } = config.externalServices;
  logger.info({ sriEnvironment, sriHost: new URL(sriVoucherWsdl).host }, 'SRI environment');
  if (config.environment === 'production' && sriEnvironment === 'test') {
    logger.warn(
      'SRI_ENVIRONMENT=test: invoices go to the SRI test environment, without tax validity',
    );
  }

  const { consumer, producer, httpServer, recoveryScheduler } = await createContainer(config);
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
    } catch (error) {
      logger.error({ error }, 'Error during shutdown');
    }
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

main().catch((error) => {
  if (error instanceof ConfigError) {
    // The logger is still silent: what failed is the configuration it needs
    console.error(error.message);
    process.exit(1);
  }
  logger.error(
    { error: error instanceof Error ? error.message : String(error) },
    'Application error',
  );
  process.exit(1);
});
