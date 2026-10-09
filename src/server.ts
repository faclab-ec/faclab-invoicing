import { initLogger, logger } from '#/shared/logger';

import loadConfig from './config';
import { createContainer } from './container';

const main = async () => {
  const config = await loadConfig();
  initLogger({
    level: config.logger.level,
    serviceName: config.serviceName,
    environment: config.environment,
  });

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
  logger.error(
    { error: error instanceof Error ? error.message : String(error) },
    'Application error',
  );
  process.exit(1);
});
