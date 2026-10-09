// eslint-disable-next-line @typescript-eslint/no-require-imports
const { soap } = require('strong-soap');

import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

import { soapCallDuration } from '../telemetry/metrics';

const tracer = trace.getTracer('faclab-invoicing.soap');

type SoapMethod = (
  args: Record<string, unknown>,
  callback: (err: Error | null, result: unknown) => void,
  options?: Record<string, unknown>,
) => void;

const DEFAULT_TIMEOUT_MS = 30_000;

// A slow SRI must not block the consumer: give up and let the job retry
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface SoapClientInstance {
  describe(): Record<string, unknown>;
  [methodName: string]: SoapMethod | (() => Record<string, unknown>);
}

export class SoapClient {
  private wsdlUrl: string;
  private client: SoapClientInstance | null = null;
  private serverAddress: string;

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

    const span = tracer.startSpan(`SRI ${methodName}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        'rpc.system': 'soap',
        'rpc.method': methodName,
        'server.address': this.serverAddress,
      },
    });

    const startTime = performance.now();

    try {
      const result = await withTimeout(
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

      soapCallDuration.record(performance.now() - startTime, {
        method: methodName,
        status: 'success',
      });

      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      soapCallDuration.record(performance.now() - startTime, {
        method: methodName,
        status: 'error',
      });
      throw error;
    } finally {
      span.end();
    }
  }
}
