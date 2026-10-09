import { describe, expect, it } from 'vitest';

import { invoiceIdForEvent, ReceiveSaleCommand } from '#/modules/invoice/app/commands/receive-sale';
import { InvoiceStatus } from '#/modules/invoice/domain/invoice';

import { InMemoryInvoiceRepository, makeSaleMessage } from '../helpers';

const EVENT_1 = '6f1c0f4e-6a7e-4b55-9d6e-0a8c3f2b1a01';
const EVENT_2 = '6f1c0f4e-6a7e-4b55-9d6e-0a8c3f2b1a02';

describe('ReceiveSaleCommand', () => {
  it('stores the sale as a pending invoice, without looking at the config', async () => {
    const repo = new InMemoryInvoiceRepository();

    const invoice = await new ReceiveSaleCommand(repo).execute(makeSaleMessage(EVENT_1));

    expect(invoice?.id).toBe(invoiceIdForEvent(EVENT_1));
    const stored = await repo.getInvoiceById(invoiceIdForEvent(EVENT_1));
    expect(stored?.status).toBe(InvoiceStatus.PENDING);
    expect(stored?.sale?.sale_id).toBe(42);
  });

  it('ignores the same message delivered twice', async () => {
    const repo = new InMemoryInvoiceRepository();
    const command = new ReceiveSaleCommand(repo);

    await command.execute(makeSaleMessage(EVENT_1));
    const again = await command.execute(makeSaleMessage(EVENT_1));

    expect(again).toBeNull();
    expect(repo.records.size).toBe(1);
  });

  it('ignores a resend while the sale has an active invoice', async () => {
    const repo = new InMemoryInvoiceRepository();
    const command = new ReceiveSaleCommand(repo);

    await command.execute(makeSaleMessage(EVENT_1));
    const resend = await command.execute(makeSaleMessage(EVENT_2));

    expect(resend).toBeNull();
    expect(repo.records.size).toBe(1);
  });

  it('accepts a resend once the previous invoice was rejected', async () => {
    const repo = new InMemoryInvoiceRepository();
    const command = new ReceiveSaleCommand(repo);
    const first = (await command.execute(makeSaleMessage(EVENT_1)))!;
    first.reject(['NO AUTORIZADO']);
    await repo.updateInvoice(first);

    const resend = await command.execute(makeSaleMessage(EVENT_2));

    expect(resend?.id).toBe(invoiceIdForEvent(EVENT_2));
    expect(repo.records.size).toBe(2);
  });
});
