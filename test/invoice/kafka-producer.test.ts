import { KafkaJS } from '@confluentinc/kafka-javascript';
import { describe, expect, it, vi } from 'vitest';

import { Invoice } from '#/modules/invoice/domain/invoice';
import { invoiceTenant, toInvoiceMessage } from '#/modules/invoice/infra/messaging/invoice-message';
import { KafkaProducer } from '#/modules/invoice/infra/messaging/kafka-producer';

import { makePoint, makeSale, TENANT_B } from '../helpers';

describe('KafkaProducer of the invoices topic', () => {
  it('sends the company as the key and the faclab-tenant-id header, not in the body', async () => {
    const send = vi.fn(async () => undefined);
    const producer = new KafkaProducer(
      { send } as unknown as KafkaJS.Producer,
      'invoices',
      toInvoiceMessage,
      invoiceTenant,
    );
    const invoice = Invoice.receive('inv-1', makePoint({ tenantId: TENANT_B }), makeSale());
    invoice.reject(['NO AUTORIZADO']);

    await producer.sendMessage(invoice.resultEvent()!);

    const [record] = (send.mock.calls[0] as unknown as [KafkaJS.ProducerRecord])[0].messages;
    expect(record.key).toBe(TENANT_B);
    expect(record.headers).toMatchObject({ 'faclab-tenant-id': TENANT_B });
    expect(JSON.parse(String(record.value))).not.toHaveProperty('tenantId');
  });
});
