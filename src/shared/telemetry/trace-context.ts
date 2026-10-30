import { Context, context, propagation, ROOT_CONTEXT } from '@opentelemetry/api';

// W3C trace context (traceparent, tracestate), as it travels in a Kafka header
export type TraceCarrier = Record<string, string>;

/** The active trace, to keep with work that continues later; null outside any trace */
export function captureTraceContext(): TraceCarrier | null {
  const carrier: TraceCarrier = {};
  propagation.inject(context.active(), carrier);
  return Object.keys(carrier).length > 0 ? carrier : null;
}

/** The context a stored trace continues from: a new trace without one */
export function contextFrom(carrier: TraceCarrier | null): Context {
  return carrier ? propagation.extract(ROOT_CONTEXT, carrier) : ROOT_CONTEXT;
}
