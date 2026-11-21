// eslint-disable-next-line @typescript-eslint/no-require-imports
const { soap } = require('strong-soap');

type SoapMethod = (
  args: Record<string, unknown>,
  callback: (err: Error | null, result: unknown) => void,
  options?: Record<string, unknown>,
) => void;

const DEFAULT_TIMEOUT_MS = 30_000;

/** The service didn't answer in time */
export class SoapTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms} ms`);
    this.name = 'SoapTimeoutError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// Codes of the socket giving up (strong-soap's own timeout, the connection)
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNABORTED']);

/** Whether a call failed because the service took too long */
export function isTimeout(error: unknown): boolean {
  if (error instanceof SoapTimeoutError) return true;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && TIMEOUT_CODES.has(code);
}

// A slow SRI must not block the consumer: give up and let the job retry
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SoapTimeoutError(label, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface SoapClientInstance {
  describe(): Record<string, unknown>;
  [methodName: string]: SoapMethod | (() => Record<string, unknown>);
}

/**
 * A SOAP web service, its WSDL loaded on first use. The caller traces and measures each call (the
 * SRI's adapters: `sri.recepcion`, `sri.autorizacion`); loading the WSDL and the HTTP requests get
 * their own spans from the HTTP instrumentation.
 */
export class SoapClient {
  private wsdlUrl: string;
  private client: SoapClientInstance | null = null;
  // The host of the service, for `server.address`
  readonly serverAddress: string;

  constructor(
    wsdlUrl: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {
    this.wsdlUrl = wsdlUrl;
    try {
      this.serverAddress = new URL(wsdlUrl).hostname;
    } catch {
      this.serverAddress = wsdlUrl;
    }
  }

  private async initClient(): Promise<void> {
    if (this.client) return;

    this.client = await withTimeout(
      new Promise<SoapClientInstance>((resolve, reject) => {
        soap.createClient(this.wsdlUrl, {}, (err: Error | null, client: SoapClientInstance) => {
          if (err) return reject(err);
          resolve(client);
        });
      }),
      this.timeoutMs,
      'Loading the WSDL',
    );
  }

  async describe(): Promise<Record<string, unknown>> {
    await this.initClient();
    return this.client!.describe();
  }

  async callMethod(methodName: string, args: Record<string, unknown>): Promise<unknown> {
    await this.initClient();

    return withTimeout(
      new Promise((resolve, reject) => {
        const method = this.client![methodName];
        if (typeof method !== 'function') {
          return reject(new Error(`Método '${methodName}' no encontrado en el cliente SOAP.`));
        }

        (method as SoapMethod)(
          args,
          (err: Error | null, result: unknown) => {
            if (err) return reject(err);
            resolve(result);
          },
          { timeout: this.timeoutMs },
        );
      }),
      this.timeoutMs,
      `SOAP ${methodName}`,
    );
  }
}
