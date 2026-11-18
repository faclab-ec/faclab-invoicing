import { randomUUID } from 'crypto';
import { expect, it } from 'vitest';

import { Invoice, InvoiceStatus } from '#/modules/invoice/domain/invoice';
import { PgInvoiceRepository } from '#/modules/invoice/infra/persistence/pg-invoice.repository';
import { PgRateLimiter, purgeRateLimits } from '#/shared/infra/http/rate-limit';

import { makePoint, makeSale, TENANT_A } from '../helpers';
import { anotherPool, describePostgres, usePostgres } from './support';

// The public API on PostgreSQL (S6.3): each document keeps its branch, the listing filters and
// orders the way an integration syncs, and the rate limit counters are shared by every process
describePostgres('public API', () => {
  const pool = usePostgres();
  const repo = () => new PgInvoiceRepository(pool());

  const receive = async (saleId: number, branchId: number | null, receivedAt: Date) => {
    const invoice = Invoice.receive(
      randomUUID(),
      makePoint({ branchId }),
      makeSale({ sale_id: saleId }),
      receivedAt,
    );
    await repo().createInvoice(invoice);
    return invoice;
  };

  it('keeps the branch of each document and lists by the branches a client may see', async () => {
    const of12 = await receive(1, 12, new Date('2026-11-17T10:00:00Z'));
    const of15 = await receive(2, 15, new Date('2026-11-17T11:00:00Z'));
    const old = await receive(3, null, new Date('2026-11-17T12:00:00Z'));

    expect((await repo().getInvoiceById(of12.id))!.point.branchId).toBe(12);
    expect((await repo().getInvoiceById(old.id))!.point.branchId).toBeNull();

    const page = { limit: 10, offset: 0, sort: { field: 'createdAt' as const, descending: false } };
    const limited = await repo().findPage(TENANT_A, { branchIds: [12, 15] }, page);
    const one = await repo().findPage(TENANT_A, { branchId: 15 }, page);
    const all = await repo().findPage(TENANT_A, {}, page);

    expect(limited.items.map((i) => i.id)).toEqual([of12.id, of15.id]);
    expect(limited.total).toBe(2);
    expect(one.items.map((i) => i.id)).toEqual([of15.id]);
    expect(all.items.map((i) => i.id)).toEqual([of12.id, of15.id, old.id]);
  });

  it('filters by sale, statuses and update time, in a stable order', async () => {
    const first = await receive(1, 12, new Date('2026-11-17T10:00:00Z'));
    const second = await receive(2, 12, new Date('2026-11-17T11:00:00Z'));

    const page = { limit: 10, offset: 0, sort: { field: 'updatedAt' as const, descending: true } };
    const bySale = await repo().findPage(TENANT_A, { saleId: '2' }, page);
    const pending = await repo().findPage(TENANT_A, { statuses: [InvoiceStatus.PENDING] }, page);
    const authorized = await repo().findPage(
      TENANT_A,
      { statuses: [InvoiceStatus.AUTHORIZED] },
      page,
    );
    const since = await repo().findPage(
      TENANT_A,
      { updatedSince: new Date('2026-11-17T10:30:00Z') },
      page,
    );

    expect(bySale.items.map((i) => i.id)).toEqual([second.id]);
    expect(pending.items.map((i) => i.id)).toEqual([second.id, first.id]);
    expect(authorized.total).toBe(0);
    expect(since.items.map((i) => i.id)).toEqual([second.id]);
  });

  it('shares the rate limit counters between processes', async () => {
    const other = anotherPool(pool());
    const clock = () => 1000;
    const limit = { perMinute: 60, burst: 2 };
    try {
      const first = await new PgRateLimiter(pool(), clock).check([['client:a', limit]]);
      const second = await new PgRateLimiter(other, clock).check([['client:a', limit]]);
      const third = await new PgRateLimiter(pool(), clock).check([['client:a', limit]]);

      expect([first.allowed, first.remaining]).toEqual([true, 1]);
      expect([second.allowed, second.remaining]).toEqual([true, 0]);
      expect([third.allowed, third.retryAfter]).toEqual([false, 1]);
      // A second later one fits again; the bucket is full once its time passed
      expect(
        (await new PgRateLimiter(pool(), () => 1001).check([['client:a', limit]])).allowed,
      ).toBe(true);
      expect(await purgeRateLimits(pool(), 1001)).toBe(0);
      expect(await purgeRateLimits(pool(), 1004)).toBe(1);
    } finally {
      await other.end();
    }
  });
});
