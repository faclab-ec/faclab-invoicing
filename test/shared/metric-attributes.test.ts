import { KafkaJS } from '@confluentinc/kafka-javascript';
import { describe, expect, it } from 'vitest';

import { CertificateExpiryReport } from '#/modules/certificate/app/certificate-expiry';
import { sampleCertificates } from '#/modules/certificate/infra/telemetry';
import { IssuerReadinessService } from '#/modules/company-config/app/issuer-readiness';
import { IssuerNotReadyError } from '#/modules/company-config/domain/readiness';
import { VoucherType } from '#/modules/company-config/domain/sequence';
import { InvoiceProcessor } from '#/modules/invoice/app/services/invoice-processor';
import { Invoice, InvoiceStatus } from '#/modules/invoice/domain/invoice';
import { SriAuthorizationAdapter } from '#/modules/invoice/infra/adapters/sri-authorization.adapter';
import { SriValidationAdapter } from '#/modules/invoice/infra/adapters/sri-validation.adapter';
import { KafkaProducer } from '#/modules/invoice/infra/messaging/kafka-producer';
import { recordDelivery } from '#/modules/invoice/infra/telemetry/delivery-metrics';
import {
  sampleInvoiceQueue,
  samplePendingDeliveries,
} from '#/modules/invoice/infra/telemetry/queue-metrics';
import { measureSteps } from '#/modules/invoice/infra/telemetry/step-metrics';
import { ValidationError } from '#/shared/errors/app-error';
import { DeadLetterStore, sampleDeadLetters } from '#/shared/infra/dead-letters';
import { BaseKafkaConsumer } from '#/shared/infra/kafka';
import { SoapTimeoutError } from '#/shared/infra/soap-client';

import {
  InMemoryInvoiceRepository,
  invoiceSteps,
  makeCertificate,
  makeConfig,
  makePoint,
  makeSale,
  readinessStub,
  simulatedSoap,
  sriAnswering,
  TENANT_A,
} from '../helpers';
import { RecordedPoint, useRecordedMetrics } from '../metrics';

/**
 * Every metric of the service, its unit and the only attributes it may carry. A new metric goes
 * here, or this test fails: OBSERVABILITY.md §6 forbids ids of companies, sales, invoices or
 * certificates as attributes, which would make the series unbounded.
 */
const CATALOG: Record<string, { unit: string; attributes: string[] }> = {
  'faclab.sri.request.duration': {
    unit: 's',
    attributes: ['faclab.sri.operation', 'faclab.sri.outcome', 'faclab.sri.environment'],
  },
  'faclab.invoices.rejections': {
    unit: '{document}',
    attributes: ['faclab.sri.message.code', 'faclab.sri.operation'],
  },
  'faclab.invoices.transitions': {
    unit: '{transition}',
    attributes: ['from', 'to', 'faclab.document.type'],
  },
  'faclab.invoices.time_to_final': { unit: 's', attributes: ['result', 'faclab.document.type'] },
  'faclab.invoices.step.duration': {
    unit: 's',
    attributes: ['faclab.invoice.step', 'faclab.step.outcome', 'faclab.document.type'],
  },
  'faclab.invoices.pending': {
    unit: '{document}',
    attributes: ['status', 'faclab.issue.type', 'faclab.document.type'],
  },
  'faclab.invoices.oldest_age': { unit: 's', attributes: ['status'] },
  'faclab.invoices.due': { unit: '{document}', attributes: [] },
  'faclab.invoices.expired_leases': { unit: '{document}', attributes: [] },
  'faclab.invoices.deliveries': { unit: '{delivery}', attributes: ['result'] },
  'faclab.invoices.pending_deliveries': { unit: '{delivery}', attributes: [] },
  'faclab.certificates.expiring': { unit: '{certificate}', attributes: ['window'] },
  'messaging.process.duration': {
    unit: 's',
    attributes: [
      'messaging.system',
      'messaging.operation.name',
      'messaging.destination.name',
      'messaging.consumer.group.name',
      'error.type',
    ],
  },
  'messaging.client.sent.messages': {
    unit: '{message}',
    attributes: [
      'messaging.system',
      'messaging.operation.name',
      'messaging.destination.name',
      'error.type',
    ],
  },
  'faclab.dead_letters.pending': { unit: '{message}', attributes: ['messaging.destination.name'] },
};

const recorded = useRecordedMetrics();

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// A RUC, an access code, a sale number: five digits or more in a row
const LONG_NUMBER = /\d{5,}/;

function expectBounded(point: RecordedPoint) {
  const entry = CATALOG[point.name];
  expect(entry, `${point.name} is not in the catalog`).toBeDefined();
  expect(point.unit, point.name).toBe(entry.unit);
  for (const [key, value] of Object.entries(point.attributes)) {
    expect(entry.attributes, `${point.name} carries ${key}`).toContain(key);
    expect(key.toLowerCase().endsWith('id'), `${point.name}: ${key} names an id`).toBe(false);
    expect(String(value), `${point.name}: ${key}=${value}`).not.toMatch(UUID);
    expect(String(value), `${point.name}: ${key}=${value}`).not.toMatch(LONG_NUMBER);
  }
}

async function runPipeline() {
  const repo = new InMemoryInvoiceRepository();
  const ready = readinessStub({ config: makeConfig(), certificate: makeCertificate() });
  // The second invoice is returned with error 35
  const clients = simulatedSoap({ rejects: (xml) => xml.includes('000000002') });
  const reception = new SriValidationAdapter(clients);
  const authorization = new SriAuthorizationAdapter(clients);
  const processorWith = (readiness: IssuerReadinessService) =>
    new InvoiceProcessor(
      repo,
      repo,
      measureSteps(
        invoiceSteps(repo, readiness, {
          sri: {
            validateXml: (xml, environment) => reception.validateXml(xml, environment),
            authorizeXml: (code, environment) => authorization.authorizeXml(code, environment),
          },
        }),
      ),
      readiness,
      { sendMessage: async () => undefined },
    );

  // Authorized, rejected by the SRI, and one whose issuer isn't ready
  for (const [index, id] of ['inv-1', 'inv-2', 'inv-3'].entries()) {
    const sale = makeSale({ sale_id: index + 1 });
    await repo.createInvoice(Invoice.receive(id, makePoint(), sale, new Date(), new Date()));
  }
  await processorWith(ready).run('inv-1');
  await processorWith(ready).run('inv-2');
  await processorWith(readinessStub(new IssuerNotReadyError('CERTIFICATE_EXPIRED', 'expired'))).run(
    'inv-3',
  );

  // And an SRI that doesn't answer
  const slow = sriAnswering(async () => {
    throw new SoapTimeoutError('SOAP validarComprobante', 30_000);
  }, 'cel.sri.gob.ec');
  await new SriValidationAdapter(slow)
    .validateXml('<factura/>', makeConfig().environment)
    .catch(() => undefined);
}

class RecordingConsumer extends BaseKafkaConsumer {
  protected async handleMessage(_topic: string, message: string): Promise<void> {
    if (message === 'bad') throw new ValidationError('Invalid message');
  }
}

async function runKafka() {
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
  await new RecordingConsumer(kafka, ['sales.confirmed'], deadLetters, {
    groupId: 'faclab-invoicing',
  }).start();
  for (const [offset, value] of ['good', 'bad'].entries()) {
    await eachMessage!({
      topic: 'sales.confirmed',
      partition: 0,
      message: { key: null, value: Buffer.from(value), headers: {}, offset: String(offset) },
    } as unknown as KafkaJS.EachMessagePayload);
  }

  let fail = false;
  const producer = new KafkaProducer<{ tenantId: string }>(
    {
      send: async () => {
        if (fail) throw new Error('Broker transport failure');
      },
    } as unknown as KafkaJS.Producer,
    'invoices',
    (message) => message,
    (message) => message.tenantId,
  );
  await producer.sendMessage({ tenantId: TENANT_A });
  fail = true;
  await producer.sendMessage({ tenantId: TENANT_A }).catch(() => undefined);
}

async function runSamplers() {
  const now = new Date();
  await sampleInvoiceQueue(
    {
      stats: async () => ({
        inFlight: [
          {
            status: InvoiceStatus.PENDING,
            docType: VoucherType.INVOICE,
            issueCode: 'CERTIFICATE_EXPIRED',
            count: 3,
            oldestCreatedAt: new Date(now.getTime() - 3_600_000),
          },
          {
            status: InvoiceStatus.SENT,
            docType: VoucherType.CREDIT_NOTE,
            // A code of an older version
            issueCode: 'SOMETHING_OLD',
            count: 1,
            oldestCreatedAt: new Date(now.getTime() - 60_000),
          },
        ],
        due: 2,
        expiredLeases: 1,
      }),
    },
    now,
    60_000,
  );
  await samplePendingDeliveries({ countPending: async () => 4 }, 60_000);
  await sampleDeadLetters(
    { countPendingByTopic: async () => new Map([['sales.confirmed', 2]]) },
    ['sales.confirmed', 'credit_notes.requested'],
    60_000,
  );
  await sampleCertificates(
    new CertificateExpiryReport({
      listSelected: async () => [
        {
          tenantId: TENANT_A,
          certificateId: 'cert-1',
          validTo: new Date(now.getTime() + 86_400_000),
        },
      ],
    }),
    60_000,
  );
  for (const status of [
    'sent',
    'pending',
    'bounced',
    'failed',
    'no_recipient',
    'disabled',
  ] as const) {
    recordDelivery(status);
  }
}

describe('Metric attributes', () => {
  it('emits every metric of the catalog, with its unit and only bounded attributes', async () => {
    await runPipeline();
    await runKafka();
    await runSamplers();

    const points = await recorded.collect();

    expect(points.names()).toEqual(Object.keys(CATALOG).sort());
    for (const point of points) expectBounded(point);
  });

  it('keeps an unknown issue code out of the attributes', async () => {
    await runSamplers();

    const points = await recorded.collect();
    expect(
      points.total('faclab.invoices.pending', {
        status: 'sent',
        'faclab.issue.type': 'other',
        'faclab.document.type': 'credit_note',
      }),
    ).toBe(1);
    expect(
      points.total('faclab.invoices.pending', {
        status: 'pending',
        'faclab.issue.type': 'CERTIFICATE_EXPIRED',
      }),
    ).toBe(3);
    expect(
      points.total('faclab.invoices.oldest_age', { status: 'pending' }),
    ).toBeGreaterThanOrEqual(3600);
    expect(
      points.total('faclab.dead_letters.pending', {
        'messaging.destination.name': 'credit_notes.requested',
      }),
    ).toBe(0);
  });
});
