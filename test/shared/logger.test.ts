import { describe, expect, it } from 'vitest';

import { initLogger } from '#/shared/logger';

const capture = () => {
  const lines: string[] = [];
  const log = initLogger(
    {
      level: 'info',
      serviceName: 'faclab-invoicing',
      serviceVersion: '1.2.3',
      environment: 'production',
    },
    { write: (line: string) => lines.push(line) },
  );
  return { log, lines };
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
});
