import { AddressInfo } from 'net';
import { SMTPServer } from 'smtp-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InvoiceDeliveryProcessor } from '#/modules/invoice/app/services/invoice-delivery-processor';
import { RideService } from '#/modules/invoice/app/services/ride-service';
import { rideKey } from '#/modules/invoice/domain/authorized-xml';
import { InvoiceDelivery } from '#/modules/invoice/domain/delivery';
import { MAX_AUTOMATIC_ATTEMPTS } from '#/modules/invoice/domain/issue';
import { InvoiceMailer } from '#/modules/invoice/domain/ports';
import { NodemailerInvoiceMailer } from '#/modules/invoice/infra/adapters/nodemailer-mailer.adapter';
import { PdfKitRideRenderer } from '#/modules/invoice/infra/adapters/pdfkit-ride-renderer';

import {
  InMemoryCompanyConfigRepository,
  InMemoryDocumentStorage,
  InMemoryInvoiceRepository,
  makeAuthorizedInvoice,
  makeConfig,
  makePoint,
  makeSale,
  TENANT_A,
  TEST_ACCESS_CODE,
} from '../helpers';

const BUYER_EMAIL = 'compras@andinas.ec';
const FROM = 'facturas@faclab.test';

interface Received {
  from: string;
  to: string[];
  raw: string;
}

/** A mail server in the test: keeps what it receives, or answers `refuse` to the recipient */
async function testSmtpServer() {
  const received: Received[] = [];
  const state: { refuse: { code: number; message: string } | null } = { refuse: null };
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    logger: false,
    onRcptTo(_address, _session, callback) {
      if (!state.refuse) return callback();
      const error = new Error(state.refuse.message) as Error & { responseCode: number };
      error.responseCode = state.refuse.code;
      callback(error);
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
          to: session.envelope.rcptTo.map((rcpt) => rcpt.address),
          raw: Buffer.concat(chunks).toString('utf-8'),
        });
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.server.address() as AddressInfo;
  return {
    port,
    received,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function mailerOn(port: number): NodemailerInvoiceMailer {
  return new NodemailerInvoiceMailer({
    host: '127.0.0.1',
    port,
    secure: false,
    requireTls: false,
    user: null,
    password: null,
    timeoutMs: 2_000,
  });
}

describe('Delivery of an authorized invoice through a mail server', () => {
  let smtp: Awaited<ReturnType<typeof testSmtpServer>>;
  let mailer: InvoiceMailer;
  let now: Date;
  let invoices: InMemoryInvoiceRepository;
  let storage: InMemoryDocumentStorage;
  let configs: InMemoryCompanyConfigRepository;

  beforeEach(async () => {
    smtp = await testSmtpServer();
    mailer = mailerOn(smtp.port);
    now = new Date('2026-10-30T15:00:00Z');
    invoices = new InMemoryInvoiceRepository();
    storage = new InMemoryDocumentStorage();
    configs = new InMemoryCompanyConfigRepository();
    await configs.save(makeConfig({ email: 'ventas@acme.ec' }));
  });

  afterEach(async () => {
    mailer.close();
    await smtp.close();
  });

  function processor(withMailer: InvoiceMailer | null = mailer) {
    const rides = new RideService(storage, configs, new PdfKitRideRenderer(), 'America/Guayaquil');
    return new InvoiceDeliveryProcessor(
      invoices.deliveries,
      invoices,
      rides,
      storage,
      configs,
      withMailer,
      FROM,
      () => now,
    );
  }

  async function authorized(email: string | null = BUYER_EMAIL): Promise<InvoiceDelivery> {
    const customer = {
      id: 1,
      name: 'Construcciones Andinas',
      tax_id: '1790012345001',
      tax_type: 'RUC' as const,
      email,
      phone: null,
      address: null,
    };
    const invoice = await makeAuthorizedInvoice(
      'inv-1',
      makePoint(),
      storage,
      makeSale({ customer }),
    );
    await invoices.createInvoice(invoice);
    const delivery = InvoiceDelivery.forAuthorization(invoice, now);
    await invoices.deliveries.insert(delivery);
    return delivery;
  }

  const stored = async (id: string) => (await invoices.deliveries.getById(id))!;
  const RIDE_KEY = rideKey(TENANT_A, '2026', TEST_ACCESS_CODE);

  it('sends the RIDE and the authorized XML to the buyer, from the issuer, answering to it', async () => {
    const delivery = await authorized();

    await processor().run(delivery.id);

    const sent = await stored(delivery.id);
    expect(sent).toMatchObject({ status: 'sent', attempts: 0, nextAttemptAt: null });
    expect(sent.smtpResponse).toMatch(/^250 /);
    expect(sent.messageId).toBeTruthy();
    expect(smtp.received).toHaveLength(1);
    const [mail] = smtp.received;
    expect(mail.from).toBe(FROM);
    expect(mail.to).toEqual([BUYER_EMAIL]);
    expect(mail.raw).toContain(`From: ACME <${FROM}>`);
    expect(mail.raw).toContain('Reply-To: ventas@acme.ec');
    expect(mail.raw).toContain(`To: ${BUYER_EMAIL}`);
    expect(mail.raw).toContain('PRUEBAS');
    expect(mail.raw).toMatch(new RegExp(`filename=.?${TEST_ACCESS_CODE}\\.xml`));
    expect(mail.raw).toMatch(new RegExp(`filename=.?${TEST_ACCESS_CODE}\\.pdf`));
    // The PDF, in base64 (%PDF-)
    expect(mail.raw).toContain('JVBERi0');
    expect(storage.objects.get(RIDE_KEY)?.contentType).toBe('application/pdf');
  });

  it('retries a temporary failure a minute later, and sends it then', async () => {
    const delivery = await authorized();
    smtp.state.refuse = { code: 451, message: 'Try again later' };

    await processor().run(delivery.id);

    const waiting = await stored(delivery.id);
    expect(waiting).toMatchObject({ status: 'pending', attempts: 1 });
    expect(waiting.nextAttemptAt).toEqual(new Date(now.getTime() + 60_000));
    expect(waiting.lastError).toBeTruthy();
    expect(smtp.received).toHaveLength(0);

    // The queue gives it out again once due
    smtp.state.refuse = null;
    now = new Date(now.getTime() + 61_000);
    expect(await invoices.deliveries.claimDue('worker', 60_000, 1)).toHaveLength(1);
    await processor().run(delivery.id);

    expect(await stored(delivery.id)).toMatchObject({ status: 'sent', attempts: 1 });
    expect(smtp.received).toHaveLength(1);
  });

  it('retries when the mail server cannot be reached', async () => {
    const delivery = await authorized();
    await smtp.close();

    await processor().run(delivery.id);

    expect(await stored(delivery.id)).toMatchObject({ status: 'pending', attempts: 1 });
  });

  it('does not retry an address the mail server refuses', async () => {
    const delivery = await authorized();
    smtp.state.refuse = { code: 550, message: 'Mailbox unavailable' };

    await processor().run(delivery.id);

    const bounced = await stored(delivery.id);
    expect(bounced).toMatchObject({ status: 'bounced', attempts: 1, nextAttemptAt: null });
    expect(bounced.smtpResponse).toContain('550');
  });

  it('gives up after the last automatic attempt', async () => {
    const delivery = await authorized();
    const tired = await stored(delivery.id);
    tired.attempts = MAX_AUTOMATIC_ATTEMPTS - 1;
    await invoices.deliveries.update(tired);
    smtp.state.refuse = { code: 421, message: 'Service not available' };

    await processor().run(delivery.id);

    expect(await stored(delivery.id)).toMatchObject({
      status: 'failed',
      attempts: MAX_AUTOMATIC_ATTEMPTS,
      nextAttemptAt: null,
    });
  });

  it('keeps only the RIDE when the buyer has no email or sending is off', async () => {
    const withoutEmail = await authorized(null);
    await processor().run(withoutEmail.id);
    expect((await stored(withoutEmail.id)).status).toBe('no_recipient');
    expect(storage.objects.has(RIDE_KEY)).toBe(true);

    storage.objects.delete(RIDE_KEY);
    invoices.deliveries.records.clear();
    const off = InvoiceDelivery.resend((await invoices.getInvoiceById('inv-1'))!, 'Ana', now);
    await invoices.deliveries.insert(off);
    await processor(null).run(off.id);
    expect((await stored(off.id)).status).toBe('disabled');
    expect(storage.objects.has(RIDE_KEY)).toBe(true);
    expect(smtp.received).toHaveLength(0);
  });

  it('leaves alone a delivery that already ended', async () => {
    const delivery = await authorized();
    await processor().run(delivery.id);
    await processor().run(delivery.id);

    expect(smtp.received).toHaveLength(1);
  });
});
