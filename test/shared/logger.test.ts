import { trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'vitest';

import { captureLogs, silenceLogs } from '../logs';
import { useSpans } from '../tracing';

const spans = useSpans();

afterEach(silenceLogs);

const capture = () => {
  const logs = captureLogs({ serviceVersion: '1.2.3' });
  return { log: logs.log, lines: logs.raw };
};

describe('logger', () => {
  it('never writes passwords, tokens, authorization or signed XML, at any depth', () => {
    const { log, lines } = capture();

    log.info(
      {
        password: 'p4ssw0rd',
        body: { refresh_token: 'refresh-123', items: [{ Authorization: 'Bearer abc.def' }] },
        xml: '<factura>firmada</factura>',
        certificatePassword: 'kept, not on the list',
        saleId: 42,
      },
      'Certificate uploaded',
    );

    const [line] = lines;
    for (const secret of ['p4ssw0rd', 'refresh-123', 'abc.def', 'firmada']) {
      expect(line).not.toContain(secret);
    }
    const entry = JSON.parse(line);
    expect(entry.password).toBe('[REDACTED]');
    expect(entry.body.refresh_token).toBe('[REDACTED]');
    expect(entry.body.items[0].Authorization).toBe('[REDACTED]');
    expect(entry.saleId).toBe(42);
  });

  it("never writes the buyers' email addresses nor the SMTP password", () => {
    const { log, lines } = capture();

    log.info(
      {
        deliveryId: 'd-1',
        recipient: 'compras@andinas.ec',
        mail: { replyTo: 'ventas@acme.ec', email: 'otro@andinas.ec' },
        smtp_password: 'smtp-secret',
      },
      'Invoice delivery',
    );

    const [line] = lines;
    for (const secret of [
      'compras@andinas.ec',
      'ventas@acme.ec',
      'otro@andinas.ec',
      'smtp-secret',
    ]) {
      expect(line).not.toContain(secret);
    }
    expect(JSON.parse(line).deliveryId).toBe('d-1');
  });

  it('names the service and keeps errors for the serializer', () => {
    const { log, lines } = capture();

    log.error({ err: new Error('SRI unavailable') }, 'Send failed');

    const entry = JSON.parse(lines[0]);
    expect(entry['service.name']).toBe('faclab-invoicing');
    expect(entry['service.version']).toBe('1.2.3');
    expect(entry['deployment.environment.name']).toBe('production');
    expect(entry.err.message).toBe('SRI unavailable');
    expect(entry.err.stack).toContain('Error: SRI unavailable');
  });

  it('carries the ids of the active span, so the log and its trace find each other', () => {
    const { log, lines } = capture();

    trace.getTracer('test').startActiveSpan('process invoice', (span) => {
      log.info({ 'event.name': 'invoice.sale.received' }, 'Sale received for invoicing');
      span.end();
    });
    log.info('Outside any span');

    const job = spans.finished('process invoice');
    const [inside, outside] = lines.map((line) => JSON.parse(line));
    expect(inside).toMatchObject({
      trace_id: job.spanContext().traceId,
      span_id: job.spanContext().spanId,
      trace_flags: '01',
      'event.name': 'invoice.sale.received',
    });
    expect(outside).not.toHaveProperty('trace_id');
    expect(outside).not.toHaveProperty('span_id');
  });

  // S8.7 (LOPDP): the data of the people the company invoices never reaches a log or a span
  it("never writes a buyer's identification, address, phone nor the customer object", () => {
    const { log, lines } = capture();

    log.info(
      {
        saleId: 42,
        customer: { name: 'Construcciones Andinas', tax_id: '1790012345001' },
        buyer: { address: 'Av. Amazonas N34-120', Phone: '0999111222' },
        taxId: '1790012345001',
      },
      'Sale received',
    );

    const [line] = lines;
    for (const personal of ['Construcciones', '1790012345001', 'Amazonas', '0999111222']) {
      expect(line).not.toContain(personal);
    }
    expect(JSON.parse(line).saleId).toBe(42);
  });

  it('scrubs the emails and identifications an error message quotes', () => {
    const { log, lines } = capture();

    log.error(
      { err: new Error('Invalid value 1790012345001 for ana@andinas.ec (cédula 1710034065)') },
      'Validation failed',
    );

    const [line] = lines;
    for (const personal of ['1790012345001', 'ana@andinas.ec', '1710034065']) {
      expect(line).not.toContain(personal);
    }
    const entry = JSON.parse(line);
    expect(entry.err.message).toBe('Invalid value 17*********01 for [email] (cédula 17******65)');
    expect(entry.err.stack).not.toContain('ana@andinas.ec');
  });
});
