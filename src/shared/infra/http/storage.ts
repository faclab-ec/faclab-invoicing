import { AppError, storageUnavailable } from '#/shared/errors/app-error';
import { logger } from '#/shared/logger';

/**
 * Runs work that reads or writes the object storage: what the storage throws becomes 503
 * `STORAGE_UNAVAILABLE`, while the application's own errors keep their status and code.
 */
export async function withStorage<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error({ err: error }, 'The document storage failed');
    throw storageUnavailable();
  }
}
