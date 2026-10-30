import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { afterEach, expect, it } from 'vitest';

import { AccessCode } from '#/modules/invoice/domain/access-code';
import { authorizedXmlKey } from '#/modules/invoice/domain/authorized-xml';
import { InvoiceDelivery } from '#/modules/invoice/domain/delivery';
import { Invoice } from '#/modules/invoice/domain/invoice';
import { ConcurrentUpdateError } from '#/modules/invoice/domain/repository';
import { PgInvoiceRepository } from '#/modules/invoice/infra/persistence/pg-invoice.repository';
import { PgInvoiceDeliveryRepository } from '#/modules/invoice/infra/persistence/pg-invoice-delivery.repository';

import {
  makePoint,
  makeSale,
  RUC_B,
  signedInvoiceXml,
  TENANT_A,
  TENANT_B,
  TEST_ACCESS_CODE,
  TEST_AUTHORIZATION,
} from '../helpers';
import { anotherPool, describePostgres, usePostgres } from './support';

const BUYER = {
  id: 1,
  name: 'Construcciones Andinas',
  tax_id: '1790012345001',
  tax_type: 'RUC' as const,
  email: 'compras@andinas.ec',
  phone: null,
  address: null,
};

describePostgres('Invoice deliveries on PostgreSQL', () => {
  const pool = usePostgres();
  const extraPools: Pool[] = [];
  const invoices = () => new PgInvoiceRepository(pool());
  const deliveries = (now?: () => Date) => new PgInvoiceDeliveryRepository(pool(), now);

  afterEach(async () => {
    await Promise.all(extraPools.splice(0).map((extra) => extra.end()));
  });

  /** An invoice sent to the SRI and stored, ready to be authorized */
  async function sent(point = makePoint(), saleId = 1): Promise<Invoice> {
    const invoice = Invoice.receive(
      randomUUID(),
      point,
      makeSale({ sale_id: saleId, customer: BUYER }),
    );
    invoice.assignSequence(String(saleId).padStart(9, '0'));
    const xml = signedInvoiceXml();
    // The signature id is the certificate's, a uuid column
    invoice.prepare({
      accessCode: AccessCode.create(TEST_ACCESS_CODE),
      signatureId: randomUUID(),
      xml,
    });
    invoice.sign(xml);
    invoice.markAsSent([]);
    await invoices().createInvoice(invoice);
    return invoice;
  }

  function authorize(invoice: Invoice): InvoiceDelivery {
    invoice.authorize(
      {
        ...TEST_AUTHORIZATION,
        xmlKey: authorizedXmlKey(invoice.tenantId, '2026', TEST_ACCESS_CODE),
      },
      ['AUTORIZADO'],
    );
    return InvoiceDelivery.forAuthorization(invoice);
  }

  it('saves the authorization and its delivery together, or neither', async () => {
    const invoice = await sent();
    // Read before someone else saves it
    const stale = (await invoices().getInvoiceById(invoice.id))!;
    await invoices().saveAuthorized(invoice, authorize(invoice));

    const [delivery] = await deliveries().findByInvoice(TENANT_A, invoice.id);
    expect(delivery).toMatchObject({
      kind: 'authorization',
      recipient: 'compras@andinas.ec',
      status: 'pending',
    });

    await expect(invoices().saveAuthorized(stale, authorize(stale))).rejects.toBeInstanceOf(
      ConcurrentUpdateError,
    );
    expect(await deliveries().findByInvoice(TENANT_A, invoice.id)).toHaveLength(1);
  });

  it('starts one delivery per authorization, even when the step is saved again', async () => {
    const invoice = await sent();
    await invoices().saveAuthorized(invoice, authorize(invoice));
    const again = (await invoices().getInvoiceById(invoice.id))!;
    // Its delivery already ended: the authorization one is still unique
    const [first] = await deliveries().findByInvoice(TENANT_A, invoice.id);
    first.skip('no_recipient');
    await deliveries().update(first);

    await invoices().saveAuthorized(again, InvoiceDelivery.forAuthorization(again));

    expect(await deliveries().findByInvoice(TENANT_A, invoice.id)).toHaveLength(1);
  });

  it('gives concurrent resends the one pending delivery, and a new one once it ended', async () => {
    const invoice = await sent();
    await invoices().saveAuthorized(invoice, authorize(invoice));
    const [authorization] = await deliveries().findByInvoice(TENANT_A, invoice.id);

    // While the authorization's is pending, every resend gets it
    const others = Array.from({ length: 3 }, () => {
      const extra = anotherPool(pool());
      extraPools.push(extra);
      return new PgInvoiceDeliveryRepository(extra);
    });
    const answered = await Promise.all(
      others.map((repo) => repo.createResend(InvoiceDelivery.resend(invoice, 'Ana'))),
    );
    expect(answered.map((delivery) => delivery.id)).toEqual([
      authorization.id,
      authorization.id,
      authorization.id,
    ]);

    authorization.markSent({ messageId: '<m1>', response: '250 OK' });
    await deliveries().update(authorization);
    const resends = await Promise.all(
      others.map((repo) => repo.createResend(InvoiceDelivery.resend(invoice, 'Ana'))),
    );

    expect(new Set(resends.map((delivery) => delivery.id)).size).toBe(1);
    const log = await deliveries().findByInvoice(TENANT_A, invoice.id);
    expect(log.map((delivery) => [delivery.kind, delivery.status])).toEqual([
      ['resend', 'pending'],
      ['authorization', 'sent'],
    ]);
    expect(log[1]).toMatchObject({ messageId: '<m1>', smtpResponse: '250 OK' });
    expect(log[0].requestedBy).toBe('Ana');
  });

  it('never gives the same delivery to two holders, and gives it again once its lease ends', async () => {
    // The deliveries are due when they were created
    let now = new Date(Date.now() + 1_000);
    const clock = () => now;
    for (let n = 1; n <= 4; n++) {
      const invoice = await sent(makePoint(), n);
      await invoices().saveAuthorized(invoice, authorize(invoice));
    }
    const extra = anotherPool(pool());
    extraPools.push(extra);
    const repo = deliveries(clock);
    const other = new PgInvoiceDeliveryRepository(extra, clock);

    const [a, b] = await Promise.all([
      repo.claimDue('a', 60_000, 4),
      other.claimDue('b', 60_000, 4),
    ]);
    const taken = [...a, ...b].map((job) => job.id);
    expect(taken).toHaveLength(4);
    expect(new Set(taken).size).toBe(4);
    expect(await repo.claimDue('c', 60_000, 4)).toEqual([]);

    // Released or postponed: due again when the queue says
    await repo.release(taken[0], a.some((job) => job.id === taken[0]) ? 'a' : 'b');
    expect((await repo.claimDue('c', 60_000, 4)).map((job) => job.id)).toEqual([taken[0]]);
    await repo.postpone(taken[0], new Date(now.getTime() + 120_000));

    now = new Date(now.getTime() + 61_000);
    expect((await repo.claimDue('d', 60_000, 10)).map((job) => job.id).sort()).toEqual(
      taken.slice(1).sort(),
    );
  });

  it('never takes a delivery that ended', async () => {
    const invoice = await sent();
    await invoices().saveAuthorized(invoice, authorize(invoice));
    const [delivery] = await deliveries().findByInvoice(TENANT_A, invoice.id);
    delivery.markBounced('550 User unknown');
    await deliveries().update(delivery);

    expect(await deliveries().claimDue('a', 60_000, 10)).toEqual([]);
  });

  it("shows only the company's send log", async () => {
    const ofA = await sent();
    const ofB = await sent(makePoint({ tenantId: TENANT_B, issuerRuc: RUC_B }));
    await invoices().saveAuthorized(ofA, authorize(ofA));
    await invoices().saveAuthorized(ofB, authorize(ofB));

    expect(await deliveries().findByInvoice(TENANT_A, ofB.id)).toEqual([]);
    expect(await deliveries().findByInvoice(TENANT_B, ofB.id)).toHaveLength(1);
    expect(await deliveries().findByInvoice(TENANT_A, 'not-a-uuid')).toEqual([]);
    expect(await deliveries().getById('not-a-uuid')).toBeNull();
  });
});
