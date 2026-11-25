import { context, SpanKind, trace } from '@opentelemetry/api';

import { Environment } from '#/modules/company-config/domain/company-config';
import { isTimeout, SoapClient } from '#/shared/infra/soap-client';
import { errorType } from '#/shared/telemetry/attributes';
import { invoiceRejections, sriRequestDuration } from '#/shared/telemetry/metrics';
import { failSpan } from '#/shared/telemetry/spans';

import { InvoiceIssueError } from '../../domain/issue';

// The two web services, as the spans name them (OBSERVABILITY.md §5.2)
export type SriOperation = 'recepcion' | 'autorizacion';

const SERVICE_NAME: Record<SriOperation, string> = {
  recepcion: 'reception',
  autorizacion: 'authorization',
};

const ENVIRONMENT_LABEL: Record<Environment, string> = {
  [Environment.TESTING]: 'pruebas',
  [Environment.PRODUCTION]: 'produccion',
};

// An SRI code is a number of a few digits: anything else would make the metric unbounded
const SRI_CODE = /^\d{1,4}$/;

/** The code of a rejection as a metric attribute: `none` without one, `other` if it isn't a code */
export function rejectionCodeLabel(code: string | null): string {
  if (code === null) return 'none';
  return SRI_CODE.test(code) ? code : 'other';
}

export interface SriCall {
  operation: SriOperation;
  environment: Environment;
  client: SoapClient;
  method: string;
  args: Record<string, unknown>;
}

/** What the SRI answered, read from its response */
export interface SriAnswer<T> {
  result: T;
  // Its state: RECIBIDA, DEVUELTA, AUTORIZADO, NO AUTORIZADO, EN PROCESO
  status: string;
  // Present when the answer rejects the document: the code of its first error (null without one)
  rejectionCode?: string | null;
}

const tracer = trace.getTracer('faclab-invoicing.sri');

/**
 * Calls a web service of the SRI in a `sri.<operation>` span (kind CLIENT) and measures it: the
 * duration by outcome (`ok`, `timeout`, `error`) and, when the SRI rejects the document, the
 * rejection by its code. Neither the XML nor the access code goes into the span.
 *
 * A call that gets no answer is `SRI_UNAVAILABLE` (retried later); `read` turns the answer into
 * the result, and what it throws goes up as it is.
 */
export async function callSri<R, T>(call: SriCall, read: (response: R) => SriAnswer<T>) {
  const { operation, environment, client, method, args } = call;
  const attributes = {
    'faclab.sri.operation': operation,
    'faclab.sri.environment': ENVIRONMENT_LABEL[environment],
  };
  const span = tracer.startSpan(`sri.${operation}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      'rpc.system': 'soap',
      'rpc.method': method,
      'server.address': client.serverAddress,
      'faclab.sri.environment': attributes['faclab.sri.environment'],
    },
  });

  // The HTTP requests of the call are children of this span
  return context.with(trace.setSpan(context.active(), span), async (): Promise<T> => {
    const startTime = performance.now();
    try {
      let response: R;
      try {
        response = (await client.callMethod(method, args)) as R;
      } catch (error) {
        const timeout = isTimeout(error);
        sriRequestDuration.record(elapsedSeconds(startTime), {
          ...attributes,
          'faclab.sri.outcome': timeout ? 'timeout' : 'error',
        });
        span.setAttribute('error.type', timeout ? 'timeout' : errorType(error));
        throw unavailable(operation, error);
      }
      sriRequestDuration.record(elapsedSeconds(startTime), {
        ...attributes,
        'faclab.sri.outcome': 'ok',
      });

      const answer = read(response);
      span.setAttribute('faclab.sri.status', answer.status);
      if (answer.rejectionCode !== undefined) {
        invoiceRejections.add(1, {
          'faclab.sri.message.code': rejectionCodeLabel(answer.rejectionCode),
          'faclab.sri.operation': operation,
        });
      }
      return answer.result;
    } catch (error) {
      failSpan(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

function unavailable(operation: SriOperation, error: unknown): InvoiceIssueError {
  const reason = error instanceof Error ? error.message : String(error);
  return new InvoiceIssueError(
    'SRI_UNAVAILABLE',
    `SRI ${SERVICE_NAME[operation]} service failed: ${reason}`,
  );
}

const elapsedSeconds = (startTime: number) => (performance.now() - startTime) / 1000;
