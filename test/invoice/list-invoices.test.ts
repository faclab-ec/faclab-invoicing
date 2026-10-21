import { describe, expect, it } from 'vitest';

import { ListInvoicesQuery } from '#/modules/invoice/app/queries/invoice.queries';
import { Invoice } from '#/modules/invoice/domain/invoice';

import { InMemoryInvoiceRepository, makePoint, makeSale, TENANT_A, TENANT_B } from '../helpers';

const TIMEZONE = 'America/Guayaquil';

async function stored(repo: InMemoryInvoiceRepository, id: string, saleId: number, at: string) {
  await repo.createInvoice(
    Invoice.receive(id, makePoint(), makeSale({ sale_id: saleId }), new Date(at)),
  );
}

describe('ListInvoicesQuery', () => {
  it('reads fromDate and toDate as whole days in Ecuador, both included', async () => {
    const repo = new InMemoryInvoiceRepository();
    // 22:00 on Oct 1 in Ecuador (UTC-5), already Oct 2 in UTC
    await stored(repo, 'oct-1-night', 1, '2026-10-02T03:00:00Z');
    await stored(repo, 'oct-2-morning', 2, '2026-10-02T13:00:00Z');
    await stored(repo, 'oct-3-night', 3, '2026-10-04T04:59:00Z');
    await stored(repo, 'oct-4', 4, '2026-10-04T05:00:00Z');

    const page = await new ListInvoicesQuery(repo, TIMEZONE).execute(TENANT_A, {
      fromDate: '2026-10-02',
      toDate: '2026-10-03',
      limit: 10,
      offset: 0,
    });

    expect(page.items.map((invoice) => invoice.id)).toEqual(['oct-3-night', 'oct-2-morning']);
    expect(page.total).toBe(2);
  });

  it('pages what matches', async () => {
    const repo = new InMemoryInvoiceRepository();
    for (const n of [1, 2, 3]) await stored(repo, `inv-${n}`, n, `2026-10-0${n}T15:00:00Z`);

    const page = await new ListInvoicesQuery(repo, TIMEZONE).execute(TENANT_A, {
      limit: 2,
      offset: 1,
    });

    expect(page.items.map((invoice) => invoice.id)).toEqual(['inv-2', 'inv-1']);
    expect(page.total).toBe(3);
  });

  it("lists only the caller's company's invoices", async () => {
    const repo = new InMemoryInvoiceRepository();
    await stored(repo, 'of-a', 1, '2026-10-01T15:00:00Z');
    await repo.createInvoice(
      Invoice.receive('of-b', makePoint({ tenantId: TENANT_B }), makeSale({ sale_id: 1 })),
    );

    const page = await new ListInvoicesQuery(repo, TIMEZONE).execute(TENANT_A, {
      limit: 10,
      offset: 0,
    });

    expect(page.items.map((invoice) => invoice.id)).toEqual(['of-a']);
  });
});
