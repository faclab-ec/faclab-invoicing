// A code of ours (INVOICE_IN_PROGRESS, SRI_UNAVAILABLE) or of Node (ECONNREFUSED): bounded
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * `error.type` of a failure, for spans and metrics: the code of a typed error, otherwise its class.
 * Never its message, which may carry data.
 */
export function errorType(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const { code } = error as { code?: unknown };
  if (typeof code === 'string' && ERROR_CODE.test(code)) return code;
  return error.constructor.name || error.name || 'Error';
}
