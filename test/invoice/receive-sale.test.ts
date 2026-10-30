import { describe, expect, it } from 'vitest';

import { invoiceIdForEvent, ReceiveSaleCommand } from '#/modules/invoice/app/commands/receive-sale';
import { InvoiceStatus } from '#/modules/invoice/domain/invoice';

import {
  InMemoryInvoiceRepository,
  makeAuthorizedInvoice,
  makePoint,
  makeReceivedSale,
  makeSale,
  TENANT_A,
  TENANT_B,
} from '../helpers';

const EVENT_1 = '6f1c0f4e-6a7e-4b55-9d6e-0a8c3f2b1a01';
const EVENT_2 = '6f1c0f4e-6a7e-4b55-9d6e-0a8c3f2b1a02';

describe('ReceiveSaleCommand', () => {
  it('stores the sale as a pending invoice, without looking at the config', async () => {
    const repo = new InMemoryInvoiceRepository();

    const invoice = await new ReceiveSaleCommand(repo).execute(makeReceivedSale(EVENT_1));

    expect(invoice?.id).toBe(invoiceIdForEvent(EVENT_1));
    const stored = await repo.getInvoiceById(invoiceIdForEvent(EVENT_1));
    expect(stored?.status).toBe(InvoiceStatus.PENDING);
    expect(stored?.sale?.sale_id).toBe(42);
    expect(stored?.point).toEqual(makePoint());
    expect(stored?.tenantId).toBe(TENANT_A);
  });

  it('keeps the same sale id of two companies apart', async () => {
    const repo = new InMemoryInvoiceRepository();
    const command = new ReceiveSaleCommand(repo);

    await command.execute(makeReceivedSale(EVENT_1, makeSale()));
    const other = await command.execute(
      makeReceivedSale(EVENT_2, makeSale(), makePoint({ tenantId: TENANT_B })),
    );

    expect(other?.tenantId).toBe(TENANT_B);
    expect(repo.records.size).toBe(2);
  });

  it('ignores the same message delivered twice', async () => {
    const repo = new InMemoryInvoiceRepository();
    const command = new ReceiveSaleCommand(repo);

    await command.execute(makeReceivedSale(EVENT_1));
    const again = await command.execute(makeReceivedSale(EVENT_1));

    expect(again).toBeNull();
    expect(repo.records.size).toBe(1);
  });

  it('ignores a resend while the sale has an active invoice', async () => {
    const repo = new InMemoryInvoiceRepository();
    const command = new ReceiveSaleCommand(repo);

    await command.execute(makeReceivedSale(EVENT_1));
    const resend = await command.execute(makeReceivedSale(EVENT_2));

    expect(resend).toBeNull();
    expect(repo.records.size).toBe(1);
  });

  it('accepts a resend once the previous invoice was rejected', async () => {
    const repo = new InMemoryInvoiceRepository();
    const command = new ReceiveSaleCommand(repo);
    const first = (await command.execute(makeReceivedSale(EVENT_1)))!;
    first.reject(['NO AUTORIZADO']);
    await repo.updateInvoice(first);

    const resend = await command.execute(makeReceivedSale(EVENT_2));

    expect(resend?.id).toBe(invoiceIdForEvent(EVENT_2));
    expect(repo.records.size).toBe(2);
  });

  it('publishes the result again when a resend finds the invoice authorized', async () => {
    // faclab-core resends a sale that still waits for its result: the first one never reached it
    const repo = new InMemoryInvoiceRepository();
    const authorized = await makeAuthorizedInvoice(invoiceIdForEvent(EVENT_1), makePoint(), null);
    authorized.markResultPublished(new Date('2026-10-09T15:02:00Z'));
    await repo.createInvoice(authorized);
    const now = new Date();

    const resend = await new ReceiveSaleCommand(repo).execute(makeReceivedSale(EVENT_2));

    expect(resend).toBeNull();
    expect(repo.records.size).toBe(1);
    const stored = (await repo.getInvoiceById(authorized.id))!;
    expect(stored.status).toBe(InvoiceStatus.AUTHORIZED);
    expect(stored.resultPublishedAt).toBeNull();
    // Due right away: the worker publishes InvoiceAuthorized again
    expect(stored.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(now.getTime());
  });

  it('leaves alone an authorized invoice whose result is still to go out', async () => {
    const repo = new InMemoryInvoiceRepository();
    const authorized = await makeAuthorizedInvoice(invoiceIdForEvent(EVENT_1), makePoint(), null);
    await repo.createInvoice(authorized);
    const version = (await repo.getInvoiceById(authorized.id))!.version;

    await new ReceiveSaleCommand(repo).execute(makeReceivedSale(EVENT_2));

    expect((await repo.getInvoiceById(authorized.id))!.version).toBe(version);
  });

  it('does not publish again for the same message delivered twice', async () => {
    const repo = new InMemoryInvoiceRepository();
    const authorized = await makeAuthorizedInvoice(invoiceIdForEvent(EVENT_1), makePoint(), null);
    authorized.markResultPublished();
    await repo.createInvoice(authorized);

    await new ReceiveSaleCommand(repo).execute(makeReceivedSale(EVENT_1));

    expect((await repo.getInvoiceById(authorized.id))!.resultPublishedAt).not.toBeNull();
  });
});
