import { KafkaJS } from '@confluentinc/kafka-javascript';
import { describe, expect, it } from 'vitest';

import { KafkaProducer } from '#/modules/invoice/infra/messaging/kafka-producer';
import { ValidationError } from '#/shared/errors/app-error';
import { DeadLetterStore } from '#/shared/infra/dead-letters';
import { BaseKafkaConsumer } from '#/shared/infra/kafka';

import { useRecordedMetrics } from '../metrics';

const recorded = useRecordedMetrics();

const PROCESS = 'messaging.process.duration';
const SENT = 'messaging.client.sent.messages';

class FlakyConsumer extends BaseKafkaConsumer {
  failures = 0;

  protected async handleMessage(_topic: string, message: string): Promise<void> {
    if (message === 'malformed') throw new ValidationError('Invalid message');
    if (message === 'flaky' && this.failures++ < 2) throw new Error('database down');
  }
}

async function consume(...values: string[]) {
  let eachMessage: KafkaJS.EachMessageHandler | undefined;
  const kafka = {
    connect: async () => {},
    subscribe: async () => {},
    run: async (config: KafkaJS.ConsumerRunConfig) => {
      eachMessage = config.eachMessage;
    },
    commitOffsets: async () => {},
  } as unknown as KafkaJS.Consumer;
  const deadLetters = { keep: async () => undefined } as unknown as DeadLetterStore;
  await new FlakyConsumer(kafka, ['sales.confirmed'], deadLetters, {
    groupId: 'faclab-invoicing',
    baseDelayMs: 1,
  }).start();
  for (const [offset, value] of values.entries()) {
    await eachMessage!({
      topic: 'sales.confirmed',
      partition: 0,
      message: { key: null, value: Buffer.from(value), headers: {}, offset: String(offset) },
    } as unknown as KafkaJS.EachMessagePayload);
  }
}

describe('Messaging metrics, named like faclab-core', () => {
  it('measures each attempt of the consumer, with error.type when the handler failed', async () => {
    await consume('ok', 'flaky', 'malformed');

    const points = await recorded.collect();
    const topic = {
      'messaging.system': 'kafka',
      'messaging.operation.name': 'process',
      'messaging.destination.name': 'sales.confirmed',
      'messaging.consumer.group.name': 'faclab-invoicing',
    };
    const ok = points.of(PROCESS, topic).filter((point) => !('error.type' in point.attributes));
    // `ok`, and `flaky` on its third attempt
    expect(ok.reduce((total, point) => total + point.value, 0)).toBe(2);
    expect(points.total(PROCESS, { ...topic, 'error.type': 'Error' })).toBe(2);
    expect(points.total(PROCESS, { ...topic, 'error.type': 'VALIDATION_ERROR' })).toBe(1);
  });

  it('counts each message sent, with error.type when Kafka refused it', async () => {
    let fail = false;
    const producer = new KafkaProducer<{ id: string }>(
      {
        send: async () => {
          if (fail) throw new Error('Broker transport failure');
        },
      } as unknown as KafkaJS.Producer,
      'invoices',
    );

    await producer.sendMessage({ id: '1' });
    fail = true;
    await expect(producer.sendMessage({ id: '2' })).rejects.toThrow('Broker transport failure');

    const points = await recorded.collect();
    const topic = {
      'messaging.system': 'kafka',
      'messaging.operation.name': 'send',
      'messaging.destination.name': 'invoices',
    };
    expect(points.total(SENT, topic)).toBe(2);
    expect(points.total(SENT, { ...topic, 'error.type': 'Error' })).toBe(1);
  });
});
