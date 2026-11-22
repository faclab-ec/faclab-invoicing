import { SpanContext } from '@opentelemetry/api';
import { node, tracing } from '@opentelemetry/sdk-node';
import { beforeAll, beforeEach, expect } from 'vitest';

export type FinishedSpan = tracing.ReadableSpan;

/**
 * The spans a test finishes, kept in memory, like faclab-core's `span_exporter` (S7.6). The global
 * provider has W3C propagation and async context, as sdk-node sets up in the service; it is
 * registered once per file (vitest runs each file apart) and emptied before each test.
 *
 * Tests check only what docs/architecture/OBSERVABILITY.md fixes: span names, kinds, attributes,
 * parent and child, and the trace the logs carry.
 */
export function useSpans() {
  const exporter = new tracing.InMemorySpanExporter();

  beforeAll(() => {
    new node.NodeTracerProvider({
      spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
    }).register();
  });

  beforeEach(() => exporter.reset());

  const all = (): FinishedSpan[] => exporter.getFinishedSpans();
  const named = (name: string) => all().filter((span) => span.name === name);

  return {
    all,
    named,
    reset: () => exporter.reset(),
    /** The first finished span with that name; it fails when there is none */
    finished(name: string): FinishedSpan {
      const span = named(name)[0];
      if (!span) throw new Error(`No span named ${name}: ${all().map((s) => s.name)}`);
      return span;
    },
    childrenOf: (parent: FinishedSpan) => all().filter((span) => isChildOf(span, parent)),
    /** Whether `ancestor` is the span's parent, grandparent... among the finished spans */
    descendsFrom(span: FinishedSpan, ancestor: FinishedSpan): boolean {
      const byId = new Map(all().map((s) => [s.spanContext().spanId, s]));
      for (let current: FinishedSpan | undefined = span; current; ) {
        if (isChildOf(current, ancestor)) return true;
        const parentId: string | undefined = current.parentSpanContext?.spanId;
        current = parentId ? byId.get(parentId) : undefined;
      }
      return false;
    },
  };
}

const isChildOf = (span: FinishedSpan, parent: FinishedSpan) =>
  span.parentSpanContext?.spanId === parent.spanContext().spanId &&
  span.spanContext().traceId === parent.spanContext().traceId;

/** `child` continues `parent`'s trace with `parent` as its direct parent */
export function expectChildOf(child: FinishedSpan, parent: FinishedSpan | SpanContext) {
  const context = 'spanContext' in parent ? parent.spanContext() : parent;
  expect(child.spanContext().traceId, `${child.name} is in another trace`).toBe(context.traceId);
  expect(child.parentSpanContext?.spanId, `${child.name} has another parent`).toBe(context.spanId);
}

/** The `traceparent` another service sends from inside that span */
export const traceparentOf = (context: SpanContext) => `00-${context.traceId}-${context.spanId}-01`;

/** Trace id and parent span id of a W3C `traceparent` header */
export function traceparentIds(header: string): { traceId: string; spanId: string } {
  const [version, traceId, spanId] = header.split('-');
  expect(version).toBe('00');
  return { traceId, spanId };
}
