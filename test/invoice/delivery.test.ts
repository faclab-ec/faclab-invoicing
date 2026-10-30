import { describe, expect, it } from 'vitest';

import { buyerEmail, InvoiceDelivery } from '#/modules/invoice/domain/delivery';
import { MAX_AUTOMATIC_ATTEMPTS } from '#/modules/invoice/domain/issue';

import {
  InMemoryDocumentStorage,
  makeAuthorizedInvoice,
  makePoint,
  makeSale,
  TENANT_A,
} from '../helpers';

const NOW = new Date('2026-10-30T15:00:00Z');
const customer = (email: string | null) => ({
  id: 1,
  name: 'Construcciones Andinas',
  tax_id: '1790012345001',
  tax_type: 'RUC' as const,
  email,
  phone: null,
  address: null,
});

async function invoiceWith(email: string | null) {
  return makeAuthorizedInvoice(
    'inv-1',
    makePoint(),
    new InMemoryDocumentStorage(),
    makeSale({ customer: email === undefined ? null : customer(email) }),
  );
}

describe('buyerEmail: only the buyer email of the sale, as one address', () => {
  it.each([
    ['compras@andinas.ec', 'compras@andinas.ec'],
    ['  compras@andinas.ec ', 'compras@andinas.ec'],
    ['', null],
    ['compras@', null],
    ['a@b.ec, c@d.ec', null],
    ['Compras <compras@andinas.ec>', null],
    ['compras @andinas.ec', null],
    [`${'a'.repeat(250)}@b.ec`, null],
  ])('%j → %j', (email, expected) => {
    expect(buyerEmail(makeSale({ customer: customer(email) }))).toBe(expected);
  });

  it('is null for the final consumer', () => {
    expect(buyerEmail(makeSale({ customer: null }))).toBeNull();
    expect(buyerEmail(null)).toBeNull();
  });
});

describe('InvoiceDelivery', () => {
  it('starts due right away, to the buyer email, for the authorization or a resend', async () => {
    const invoice = await invoiceWith('compras@andinas.ec');

    expect(InvoiceDelivery.forAuthorization(invoice, NOW)).toMatchObject({
      tenantId: TENANT_A,
      invoiceId: 'inv-1',
      kind: 'authorization',
      recipient: 'compras@andinas.ec',
      requestedBy: null,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: NOW,
    });
    expect(InvoiceDelivery.resend(invoice, 'Ana Pérez', NOW)).toMatchObject({
      kind: 'resend',
      recipient: 'compras@andinas.ec',
      requestedBy: 'Ana Pérez',
      status: 'pending',
    });
  });

  it('records what the mail server answered when it accepts it', async () => {
    const delivery = InvoiceDelivery.forAuthorization(await invoiceWith('a@b.ec'), NOW);
    delivery.markSent({ messageId: '<m1@faclab>', response: '250 OK' }, NOW);

    expect(delivery).toMatchObject({
      status: 'sent',
      messageId: '<m1@faclab>',
      smtpResponse: '250 OK',
      sentAt: NOW,
      nextAttemptAt: null,
    });
  });

  it('retries a failure 1, 5, 15 and then 60 minutes later, and gives up after the last', async () => {
    const delivery = InvoiceDelivery.forAuthorization(await invoiceWith('a@b.ec'), NOW);
    const delays: number[] = [];
    for (let attempt = 1; attempt < MAX_AUTOMATIC_ATTEMPTS; attempt++) {
      delivery.recordFailure('Connection refused', NOW);
      delays.push((delivery.nextAttemptAt!.getTime() - NOW.getTime()) / 60_000);
    }
    expect(delays.slice(0, 5)).toEqual([1, 5, 15, 60, 60]);
    expect(delivery.status).toBe('pending');

    delivery.recordFailure('Connection refused', NOW);
    expect(delivery).toMatchObject({
      status: 'failed',
      attempts: MAX_AUTOMATIC_ATTEMPTS,
      nextAttemptAt: null,
      lastError: 'Connection refused',
    });
  });

  it('does not retry a bounce', async () => {
    const delivery = InvoiceDelivery.forAuthorization(await invoiceWith('a@b.ec'), NOW);
    delivery.markBounced('550 5.1.1 User unknown', NOW);

    expect(delivery).toMatchObject({
      status: 'bounced',
      attempts: 1,
      smtpResponse: '550 5.1.1 User unknown',
      nextAttemptAt: null,
    });
  });

  it('ends without sending when there is nothing to send, and only once', async () => {
    const delivery = InvoiceDelivery.forAuthorization(await invoiceWith(null), NOW);
    expect(delivery.recipient).toBeNull();

    delivery.skip('no_recipient', NOW);
    expect(delivery).toMatchObject({ status: 'no_recipient', nextAttemptAt: null });
    expect(() => delivery.skip('disabled', NOW)).toThrow('already ended');
  });
});
