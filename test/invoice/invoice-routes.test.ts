import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RetryInvoiceCommand,
  RetryInvoicesCommand,
} from '#/modules/invoice/app/commands/retry-invoice';
import {
  FindInvoicesBySaleIdQuery,
  GetInvoiceQuery,
  GetInvoicingStatusQuery,
  ListInvoicesQuery,
} from '#/modules/invoice/app/queries/invoice.queries';
import { Invoice } from '#/modules/invoice/domain/invoice';
import { registerInvoiceRoutes } from '#/modules/invoice/infra/http/invoice.routes';
import { Authorize } from '#/shared/infra/http/auth';
import { createHttpServer } from '#/shared/infra/http-server';

import { InMemoryInvoiceRepository, makeSale } from '../helpers';

const allowAll: Authorize = () => async () => undefined;

async function server(repo: InMemoryInvoiceRepository) {
  const app = await createHttpServer({
    port: 0,
    host: '127.0.0.1',
    corsOrigins: ['http://localhost:5173'],
    serviceName: 'faclab-invoicing',
    serviceVersion: 'test',
  });
  registerInvoiceRoutes(
    app,
    {
      get: new GetInvoiceQuery(repo),
      list: new ListInvoicesQuery(repo, 'America/Guayaquil'),
      findBySaleId: new FindInvoicesBySaleIdQuery(repo),
      status: vi.fn() as unknown as GetInvoicingStatusQuery,
      retry: vi.fn() as unknown as RetryInvoiceCommand,
      retryAll: vi.fn() as unknown as RetryInvoicesCommand,
    },
    allowAll,
  );
  return app;
}

describe('GET /api/invoices', () => {
  let app: Awaited<ReturnType<typeof server>> | undefined;
  afterEach(async () => app?.close());

  async function withInvoices(count: number) {
    const repo = new InMemoryInvoiceRepository();
    for (let n = 1; n <= count; n++) {
      const at = new Date(Date.UTC(2026, 9, n, 15));
      await repo.createInvoice(Invoice.receive(`inv-${n}`, makeSale({ sale_id: n }), at));
    }
    app = await server(repo);
    return app;
  }

  it('returns one page in data and the total in meta.pagination', async () => {
    const response = await (await withInvoices(3)).inject('/api/invoices?limit=2&offset=1');

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.map((invoice: { id: string }) => invoice.id)).toEqual(['inv-2', 'inv-1']);
    expect(body.data[0].statusHistory).toHaveLength(1);
    expect(body.meta.pagination).toEqual({ total: 3, limit: 2, offset: 1 });
    expect(body.meta.requestId).toBeDefined();
  });

  it('defaults to the first 100', async () => {
    const response = await (await withInvoices(1)).inject('/api/invoices');

    expect(response.json().meta.pagination).toEqual({ total: 1, limit: 100, offset: 0 });
  });

  it('filters by status and attention', async () => {
    const api = await withInvoices(2);

    const rejected = await api.inject('/api/invoices?status=rejected');
    const attention = await api.inject('/api/invoices?attention=true');

    expect(rejected.json().meta.pagination.total).toBe(0);
    expect(attention.json().meta.pagination.total).toBe(2);
  });

  it('rejects a limit out of range or a malformed date', async () => {
    const api = await withInvoices(0);

    expect((await api.inject('/api/invoices?limit=0')).statusCode).toBe(400);
    expect((await api.inject('/api/invoices?limit=1001')).statusCode).toBe(400);
    expect((await api.inject('/api/invoices?fromDate=02-10-2026')).statusCode).toBe(400);
  });
});
