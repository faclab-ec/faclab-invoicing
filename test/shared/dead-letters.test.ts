import { describe, expect, it } from 'vitest';

import { InvoiceKafkaConsumer } from '#/modules/invoice/infra/messaging/kafka-consumer';
import { NotFoundError } from '#/shared/errors/app-error';
import { NonRetryableError } from '#/shared/errors/non-retryable.error';
import {
  DeadLetter,
  DeadLetterErrorType,
  DeadLetterReprocessor,
  DeadLetterStore,
  FailedMessage,
} from '#/shared/infra/dead-letters';

import { fakeKafkaConsumer, TENANT_A } from '../helpers';

/** `dead_letters` kept in memory */
class InMemoryDeadLetterStore implements DeadLetterStore {
  readonly letters: DeadLetter[] = [];
  failing = false;

  async keep(
    message: FailedMessage,
    error: Error,
    errorType: DeadLetterErrorType,
    attempts: number,
  ): Promise<void> {
    if (this.failing) throw new Error('database is down');
    const kept = this.letters.some(
      (l) =>
        l.topic === message.topic &&
        l.partition === message.partition &&
        l.offset === message.offset,
    );
    if (kept) return;
    this.letters.push({
      ...message,
      id: this.letters.length + 1,
      consumerGroup: 'faclab-invoicing',
      tenantId: message.headers['faclab-tenant-id'] ?? null,
      error: error.message,
      errorType,
      attempts,
      status: 'pending',
      createdAt: new Date(),
      reprocessedAt: null,
      reprocessedBy: null,
      reprocessError: null,
    });
  }

  async get(id: number) {
    return this.letters.find((l) => l.id === id) ?? null;
  }

  async pending(limit: number, afterId = 0) {
    return this.letters.filter((l) => l.status === 'pending' && l.id > afterId).slice(0, limit);
  }

  async markReprocessed(id: number, by: string, at: Date) {
    Object.assign((await this.get(id))!, {
      status: 'reprocessed',
      reprocessedBy: by,
      reprocessedAt: at,
      reprocessError: null,
    });
  }

  async recordReprocessFailure(id: number, error: string) {
    (await this.get(id))!.reprocessError = error;
  }
}

function consumerWith(store: DeadLetterStore, handle: (message: unknown) => Promise<void>) {
  const kafka = fakeKafkaConsumer();
  const consumer = new InvoiceKafkaConsumer(
    kafka.consumer,
    ['sales.confirmed'],
    {
      'sales.confirmed': {
        handler: { handle },
        validator: { safeParse: (data: unknown) => ({ success: true, data }) } as never,
      },
    },
    store,
    { maxRetries: 1, baseDelayMs: 1 },
  );
  return { kafka, consumer };
}

describe('Dead letters of the consumer', () => {
  it('keeps a message that fails every retry, with its headers, and commits its offset', async () => {
    const store = new InMemoryDeadLetterStore();
    const { kafka, consumer } = consumerWith(store, async () => {
      throw new Error('database timeout');
    });
    await consumer.start();

    await kafka.deliver('sales.confirmed', { event_id: 'e-1' }, { 'faclab-tenant-id': TENANT_A });

    expect(store.letters).toHaveLength(1);
    expect(store.letters[0]).toMatchObject({
      topic: 'sales.confirmed',
      value: '{"event_id":"e-1"}',
      tenantId: TENANT_A,
      error: 'database timeout',
      errorType: 'MAX_RETRIES_EXHAUSTED',
      attempts: 2,
    });
    expect(kafka.committed).toEqual(['1']);
  });

  it('keeps a message no retry can fix right away', async () => {
    const store = new InMemoryDeadLetterStore();
    const { kafka, consumer } = consumerWith(store, async () => {
      throw new NonRetryableError('no issuer for a v1 message');
    });
    await consumer.start();

    await kafka.deliver('sales.confirmed', { event_id: 'e-1' });

    expect(store.letters[0]).toMatchObject({ errorType: 'NON_RETRYABLE', attempts: 1 });
    expect(kafka.committed).toHaveLength(1);
  });

  it("doesn't commit the offset when the message can't be kept: it comes back", async () => {
    const store = new InMemoryDeadLetterStore();
    store.failing = true;
    const { kafka, consumer } = consumerWith(store, async () => {
      throw new Error('database is down');
    });
    await consumer.start();

    await expect(kafka.deliver('sales.confirmed', { event_id: 'e-1' })).rejects.toThrow(
      'database is down',
    );
    expect(kafka.committed).toEqual([]);
  });
});

describe('DeadLetterReprocessor', () => {
  async function storeWith(...values: string[]) {
    const store = new InMemoryDeadLetterStore();
    for (const [offset, value] of values.entries()) {
      await store.keep(
        {
          topic: 'sales.confirmed',
          partition: 0,
          offset: String(offset),
          key: null,
          headers: {},
          value,
        },
        new Error('failed'),
        'MAX_RETRIES_EXHAUSTED',
        4,
      );
    }
    return store;
  }

  it("runs a dead letter through its topic's handler and records who did it", async () => {
    const store = await storeWith('{"n":1}');
    const handled: string[] = [];
    const at = new Date('2026-10-30T10:00:00Z');
    const reprocessor = new DeadLetterReprocessor(
      store,
      async (topic, value) => {
        handled.push(`${topic} ${value}`);
      },
      () => at,
    );

    expect(await reprocessor.reprocess(1, 'ana')).toEqual({ id: 1, reprocessed: true });
    expect(handled).toEqual(['sales.confirmed {"n":1}']);
    expect(store.letters[0]).toMatchObject({
      status: 'reprocessed',
      reprocessedBy: 'ana',
      reprocessedAt: at,
    });
    // Once
    const again = await reprocessor.reprocess(1, 'luis');
    expect(again.reprocessed).toBe(false);
    expect(handled).toHaveLength(1);
  });

  it('leaves pending with its error one that fails again', async () => {
    const store = await storeWith('{"n":1}');
    const reprocessor = new DeadLetterReprocessor(store, async () => {
      throw new Error('still invalid');
    });

    expect(await reprocessor.reprocess(1, 'ana')).toEqual({
      id: 1,
      reprocessed: false,
      error: 'still invalid',
    });
    expect(store.letters[0]).toMatchObject({ status: 'pending', reprocessError: 'still invalid' });
  });

  it('reprocesses every pending one in batches, failures included', async () => {
    const store = await storeWith('{"n":1}', 'broken', '{"n":3}');
    const reprocessor = new DeadLetterReprocessor(store, async (_topic, value) => {
      JSON.parse(value);
    });

    const results = await reprocessor.reprocessAll('ana', 2);

    expect(results.map((r) => [r.id, r.reprocessed])).toEqual([
      [1, true],
      [2, false],
      [3, true],
    ]);
  });

  it('fails for an id that does not exist', async () => {
    const reprocessor = new DeadLetterReprocessor(await storeWith(), async () => undefined);

    await expect(reprocessor.reprocess(9, 'ana')).rejects.toBeInstanceOf(NotFoundError);
  });
});
