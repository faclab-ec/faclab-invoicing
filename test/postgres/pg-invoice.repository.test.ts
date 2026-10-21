import { randomUUID } from 'crypto';
import { expect, it } from 'vitest';

import { AccessCode } from '#/modules/invoice/domain/access-code';
import { Invoice, InvoiceStatus } from '#/modules/invoice/domain/invoice';
import { ConcurrentUpdateError } from '#/modules/invoice/domain/repository';
import { PgInvoiceRepository } from '#/modules/invoice/infra/persistence/pg-invoice.repository';

import { makeSale } from '../helpers';
import { describePostgres, usePostgres } from './support';

const at = (iso: string) => new Date(iso);

describePostgres('PgInvoiceRepository', () => {
  const pool = usePostgres();
  const repo = () => new PgInvoiceRepository(pool());

  const receive = (saleId: number, receivedAt = new Date()) =>
    Invoice.receive(randomUUID(), makeSale({ sale_id: saleId }), receivedAt);

  // Moves a pending invoice to `created`, as PrepareInvoiceCommand does
  const prepare = (invoice: Invoice, sequence: string) => {
    invoice.assignSequence(sequence);
    invoice.prepare({
      accessCode: AccessCode.create('1'.repeat(49)),
      signatureId: randomUUID(),
      xml: '<factura/>',
    });
  };

  it('stores an invoice with its sale and history and reads it back', async () => {
    const invoice = receive(1, at('2026-10-20T15:00:00.123Z'));

    expect(await repo().createInvoice(invoice)).toBe(true);
    expect(invoice.version).toBe(1);

    const stored = (await repo().getInvoiceById(invoice.id))!;
    expect(stored.status).toBe(InvoiceStatus.PENDING);
    expect(stored.saleId).toBe('1');
    expect(stored.sale).toEqual(makeSale({ sale_id: 1 }));
    expect(stored.createdAt).toEqual(at('2026-10-20T15:00:00.123Z'));
    expect(stored.version).toBe(1);
    expect(stored.statusHistory).toEqual([
      {
        name: InvoiceStatus.PENDING,
        statusDate: at('2026-10-20T15:00:00.123Z'),
        description: 'Sale received',
      },
    ]);
  });

  it('saves each step: new history entries, sequence, XML and issue', async () => {
    const invoice = receive(2);
    await repo().createInvoice(invoice);

    const stored = (await repo().getInvoiceById(invoice.id))!;
    prepare(stored, '000000007');
    stored.recordIssue({ code: 'SRI_UNAVAILABLE', message: 'SRI down', at: new Date() });
    await repo().updateInvoice(stored);

    const prepared = (await repo().getInvoiceById(invoice.id))!;
    expect(prepared.status).toBe(InvoiceStatus.CREATED);
    expect(prepared.sequence).toBe('000000007');
    expect(prepared.accessCode?.value).toBe('1'.repeat(49));
    expect(prepared.xml).toBe('<factura/>');
    expect(prepared.issue).toMatchObject({ code: 'SRI_UNAVAILABLE', message: 'SRI down' });
    expect(prepared.attempts).toBe(1);
    expect(prepared.nextAttemptAt).not.toBeNull();
    expect(prepared.version).toBe(2);

    prepared.reject(['NO AUTORIZADO', 'Clave repetida']);
    await repo().updateInvoice(prepared);

    const rejected = (await repo().getInvoiceById(invoice.id))!;
    expect(rejected.statusHistory.map((entry) => [entry.name, entry.description])).toEqual([
      [InvoiceStatus.PENDING, 'Sale received'],
      [InvoiceStatus.CREATED, 'XML created'],
      [InvoiceStatus.REJECTED, 'NO AUTORIZADO >> Clave repetida'],
    ]);
    expect(rejected.issue).toBeNull();
  });

  it('refuses an update over a version someone else already saved', async () => {
    const invoice = receive(3);
    await repo().createInvoice(invoice);
    const first = (await repo().getInvoiceById(invoice.id))!;
    const second = (await repo().getInvoiceById(invoice.id))!;

    first.assignSequence('000000001');
    await repo().updateInvoice(first);
    second.assignSequence('000000002');

    await expect(repo().updateInvoice(second)).rejects.toBeInstanceOf(ConcurrentUpdateError);
    const stored = (await repo().getInvoiceById(invoice.id))!;
    expect(stored.sequence).toBe('000000001');
    expect(stored.statusHistory).toHaveLength(1);
  });

  it('finds nothing for an unknown or malformed id', async () => {
    expect(await repo().getInvoiceById(randomUUID())).toBeNull();
    expect(await repo().getInvoiceById('inv-1')).toBeNull();
  });

  it('refuses a second invoice with the same id', async () => {
    const invoice = receive(4);
    await repo().createInvoice(invoice);
    const again = Invoice.receive(invoice.id, makeSale({ sale_id: 4 }));

    expect(await repo().createInvoice(again)).toBe(false);
    expect(again.version).toBe(0);
  });

  it('keeps a single active invoice per sale, also when both are created at once', async () => {
    const results = await Promise.all([
      repo().createInvoice(receive(5)),
      repo().createInvoice(receive(5)),
      repo().createInvoice(receive(5)),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await repo().findBySaleId('5')).toHaveLength(1);
  });

  it('accepts a new invoice for the sale once the active one is rejected', async () => {
    const first = receive(6);
    await repo().createInvoice(first);
    first.reject(['NO AUTORIZADO']);
    await repo().updateInvoice(first);

    const second = receive(6);
    expect(await repo().createInvoice(second)).toBe(true);

    const invoices = await repo().findBySaleId('6');
    expect(invoices.map((invoice) => [invoice.id, invoice.status])).toEqual([
      [first.id, InvoiceStatus.REJECTED],
      [second.id, InvoiceStatus.PENDING],
    ]);
  });

  it('finds the invoices still in flight', async () => {
    const pending = receive(7, at('2026-10-20T10:00:00Z'));
    const created = receive(8, at('2026-10-20T11:00:00Z'));
    const rejected = receive(9, at('2026-10-20T12:00:00Z'));
    for (const invoice of [pending, created, rejected]) await repo().createInvoice(invoice);
    prepare(created, '000000001');
    await repo().updateInvoice(created);
    rejected.reject(['NO AUTORIZADO']);
    await repo().updateInvoice(rejected);

    const inFlight = await repo().findInFlight();

    expect(inFlight.map((invoice) => invoice.id)).toEqual([pending.id, created.id]);
  });

  it('pages the invoices, latest first, with the total', async () => {
    const invoices = [1, 2, 3, 4, 5].map((n) => receive(100 + n, at(`2026-10-0${n}T15:00:00Z`)));
    for (const invoice of invoices) await repo().createInvoice(invoice);
    const ids = (items: Invoice[]) => items.map((invoice) => invoice.id);

    const first = await repo().findPage({}, { limit: 2, offset: 0 });
    const last = await repo().findPage({}, { limit: 2, offset: 4 });
    const beyond = await repo().findPage({}, { limit: 2, offset: 10 });

    expect(first.total).toBe(5);
    expect(ids(first.items)).toEqual([invoices[4].id, invoices[3].id]);
    expect(ids(last.items)).toEqual([invoices[0].id]);
    expect(beyond).toEqual({ items: [], total: 5 });
    // The summary carries the history too
    expect(first.items[0].statusHistory).toHaveLength(1);
  });

  it('filters by status, creation date and attention', async () => {
    const waiting = receive(201, at('2026-10-01T15:00:00Z'));
    const rejected = receive(202, at('2026-10-02T15:00:00Z'));
    const moving = receive(203, at('2026-10-03T15:00:00Z'));
    const stuck = receive(204, at('2026-10-04T15:00:00Z'));
    for (const invoice of [waiting, rejected, moving, stuck]) await repo().createInvoice(invoice);
    rejected.reject(['NO AUTORIZADO']);
    await repo().updateInvoice(rejected);
    prepare(moving, '000000001');
    await repo().updateInvoice(moving);
    prepare(stuck, '000000002');
    stuck.recordIssue({ code: 'UNEXPECTED_ERROR', message: 'boom', at: new Date() });
    await repo().updateInvoice(stuck);
    const ids = async (filter: Parameters<PgInvoiceRepository['findPage']>[0]) => {
      const page = await repo().findPage(filter, { limit: 10, offset: 0 });
      expect(page.total).toBe(page.items.length);
      return page.items.map((invoice) => invoice.id);
    };

    expect(await ids({ status: InvoiceStatus.REJECTED })).toEqual([rejected.id]);
    expect(
      await ids({
        createdFrom: at('2026-10-02T00:00:00Z'),
        createdBefore: at('2026-10-04T00:00:00Z'),
      }),
    ).toEqual([moving.id, rejected.id]);
    // Pending or with an issue, unfinished; latest change first
    expect(await ids({ attention: true })).toEqual([stuck.id, waiting.id]);
    expect(await ids({ attention: true, status: InvoiceStatus.PENDING })).toEqual([waiting.id]);
  });
});
