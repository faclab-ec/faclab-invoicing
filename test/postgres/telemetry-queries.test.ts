import { randomUUID } from 'crypto';
import { expect, it } from 'vitest';

import { PgCertificateRepository } from '#/modules/certificate/infra/persistence/pg-certificate.repository';
import { VoucherType } from '#/modules/company-config/domain/sequence';
import { PgCompanyConfigRepository } from '#/modules/company-config/infra/persistence/pg-company-config.repository';
import { AccessCode } from '#/modules/invoice/domain/access-code';
import { authorizedXmlKey } from '#/modules/invoice/domain/authorized-xml';
import { InvoiceDelivery } from '#/modules/invoice/domain/delivery';
import { Invoice, InvoiceStatus } from '#/modules/invoice/domain/invoice';
import { PgInvoiceRepository } from '#/modules/invoice/infra/persistence/pg-invoice.repository';
import { PgInvoiceDeliveryRepository } from '#/modules/invoice/infra/persistence/pg-invoice-delivery.repository';
import { PgInvoiceQueue } from '#/modules/invoice/infra/persistence/pg-invoice-queue';
import { PgDeadLetterStore } from '#/shared/infra/dead-letters';

import {
  makeCertificate,
  makeConfig,
  makePoint,
  makeSale,
  RUC_B,
  signedInvoiceXml,
  TENANT_B,
  TEST_ACCESS_CODE,
  TEST_AUTHORIZATION,
} from '../helpers';
import { describePostgres, usePostgres } from './support';

const NOW = new Date('2026-11-21T12:00:00Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

describePostgres('What the metrics read from PostgreSQL', () => {
  const pool = usePostgres();

  /** An invoice of its own sale, received `minutes` ago */
  async function received(saleId: number, minutes: number): Promise<Invoice> {
    const invoice = Invoice.receive(
      randomUUID(),
      makePoint(),
      makeSale({ sale_id: saleId }),
      minutesAgo(minutes),
    );
    await new PgInvoiceRepository(pool()).createInvoice(invoice);
    return invoice;
  }

  const set = (invoice: Invoice, assignments: string, ...values: unknown[]) =>
    pool().query(`UPDATE invoices SET ${assignments} WHERE id = $1`, [invoice.id, ...values]);

  it('groups the documents not yet final, and counts the due ones and the expired leases', async () => {
    // Due, nobody holds it
    const due = await received(1, 90);
    await set(due, 'next_attempt_at = $2', minutesAgo(1));
    // Waiting for its issuer
    const blocked = await received(2, 30);
    await set(blocked, "issue_code = 'CERTIFICATE_EXPIRED', next_attempt_at = NULL");
    // Sent, held by a worker that died
    const abandoned = await received(3, 10);
    await set(
      abandoned,
      "status = 'sent', next_attempt_at = $2, locked_by = 'host:1:1', locked_until = $3",
      minutesAgo(5),
      minutesAgo(2),
    );
    // Held by a worker right now
    const held = await received(4, 5);
    await set(
      held,
      "status = 'signed', next_attempt_at = $2, locked_by = 'host:2:1', locked_until = $3",
      minutesAgo(1),
      new Date(NOW.getTime() + 60_000),
    );
    // Final, its result still to publish: in the queue, not in flight
    const done = await received(5, 3);
    await set(done, "status = 'authorized', next_attempt_at = $2", minutesAgo(1));

    const stats = await new PgInvoiceQueue(pool()).stats(NOW);

    const groups = stats.inFlight
      .map(({ status, issueCode, count }) => ({ status, issueCode, count }))
      .sort((a, b) => `${a.status}${a.issueCode}`.localeCompare(`${b.status}${b.issueCode}`));
    expect(groups).toEqual([
      { status: InvoiceStatus.PENDING, issueCode: 'CERTIFICATE_EXPIRED', count: 1 },
      { status: InvoiceStatus.PENDING, issueCode: null, count: 1 },
      { status: InvoiceStatus.SENT, issueCode: null, count: 1 },
      { status: InvoiceStatus.SIGNED, issueCode: null, count: 1 },
    ]);
    expect(stats.inFlight.every((group) => group.docType === VoucherType.INVOICE)).toBe(true);
    const pendingWithout = stats.inFlight.find(
      (group) => group.status === InvoiceStatus.PENDING && group.issueCode === null,
    )!;
    expect(pendingWithout.oldestCreatedAt).toEqual(minutesAgo(90));
    // The due one, the abandoned one (its lease ran out) and the result to publish
    expect(stats.due).toBe(3);
    expect(stats.expiredLeases).toBe(1);
  });

  it('counts the deliveries waiting to be sent', async () => {
    const invoices = new PgInvoiceRepository(pool());
    const deliveries = new PgInvoiceDeliveryRepository(pool());
    expect(await deliveries.countPending()).toBe(0);

    const invoice = Invoice.receive(randomUUID(), makePoint(), makeSale());
    invoice.assignSequence('000000001');
    const xml = signedInvoiceXml();
    invoice.prepare({
      accessCode: AccessCode.create(TEST_ACCESS_CODE),
      signatureId: randomUUID(),
      xml,
    });
    invoice.sign(xml);
    invoice.markAsSent([]);
    await invoices.createInvoice(invoice);
    invoice.authorize(
      {
        ...TEST_AUTHORIZATION,
        xmlKey: authorizedXmlKey(invoice.tenantId, '2026', TEST_ACCESS_CODE),
      },
      ['AUTORIZADO'],
    );
    const delivery = InvoiceDelivery.forAuthorization(invoice);
    await invoices.saveAuthorized(invoice, delivery);
    expect(await deliveries.countPending()).toBe(1);

    delivery.skip('no_recipient');
    await deliveries.update(delivery);
    expect(await deliveries.countPending()).toBe(0);
  });

  it('counts the pending dead letters by topic', async () => {
    const store = new PgDeadLetterStore(pool(), 'faclab-invoicing');
    const failed = (topic: string, offset: string) => ({
      topic,
      partition: 0,
      offset,
      key: null,
      headers: {},
      value: '{}',
    });
    await store.keep(failed('sales.confirmed', '1'), new Error('x'), 'NON_RETRYABLE', 1);
    await store.keep(failed('sales.confirmed', '2'), new Error('x'), 'NON_RETRYABLE', 1);
    await store.keep(failed('credit_notes.requested', '1'), new Error('x'), 'NON_RETRYABLE', 1);
    const [reprocessed] = await store.pending(10);
    await store.markReprocessed(reprocessed.id, 'ops', NOW);

    expect(await store.countPendingByTopic()).toEqual(
      new Map([
        ['sales.confirmed', 1],
        ['credit_notes.requested', 1],
      ]),
    );
  });

  it('lists only the certificate each issuer selected, across companies', async () => {
    const certificates = new PgCertificateRepository(pool());
    const configs = new PgCompanyConfigRepository(pool());
    const selected = makeCertificate({
      id: randomUUID(),
      validTo: new Date('2026-11-26T00:00:00Z'),
    });
    // Replaced: it expired, but nobody signs with it
    const replaced = makeCertificate({
      id: randomUUID(),
      validTo: new Date('2026-01-01T00:00:00Z'),
    });
    await certificates.save(selected);
    await certificates.save(replaced);
    await configs.save(makeConfig({ signingCertId: selected.id }));
    // Another company with a certificate it hasn't selected yet
    await certificates.save(
      makeCertificate({ id: randomUUID(), tenantId: TENANT_B, taxIds: [RUC_B] }),
    );
    await configs.save(makeConfig({ tenantId: TENANT_B, taxId: RUC_B, signingCertId: null }));

    expect(await certificates.listSelected()).toEqual([
      { tenantId: selected.tenantId, certificateId: selected.id, validTo: selected.validTo },
    ]);
  });
});
