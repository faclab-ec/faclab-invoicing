import { SpanStatusCode } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';

import { failSpan } from '#/shared/telemetry/spans';

import { useSpans } from '../tracing';

const spans = useSpans();

describe('failSpan', () => {
  it('marks the span failed without the buyer data the error quotes', async () => {
    const { trace } = await import('@opentelemetry/api');
    const span = trace.getTracer('test').startSpan('send invoices');

    failSpan(span, new Error('SRI rejected 1790012345001: mail ana@andinas.ec'));
    span.end();

    const [finished] = [spans.finished('send invoices')];
    expect(finished.status.code).toBe(SpanStatusCode.ERROR);
    expect(finished.status.message).toBe('SRI rejected 17*********01: mail [email]');
    const [event] = finished.events;
    expect(event.name).toBe('exception');
    expect(JSON.stringify(event.attributes)).not.toContain('1790012345001');
    expect(JSON.stringify(event.attributes)).not.toContain('ana@andinas.ec');
    expect(event.attributes?.['exception.type']).toBe('Error');
  });
});
