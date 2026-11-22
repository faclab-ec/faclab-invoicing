import {
  Attributes,
  Meter,
  MeterProvider,
  MetricOptions,
  metrics,
  ObservableResult,
} from '@opentelemetry/api';

/**
 * The service's metrics, all in one place (faclab-core's docs/architecture/OBSERVABILITY.md §6).
 *
 * Attributes stay bounded: never the id of a company, sale, invoice, delivery or certificate
 * (`test/shared/metric-attributes.test.ts` checks every attribute the code emits). Units follow
 * UCUM: `s`, `{document}`.
 */

const METER_NAME = 'faclab-invoicing';

// Seconds: the SDK's default buckets are meant for milliseconds
const SHORT_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];
// From a sale to the SRI's answer: seconds when all goes well, hours while the issuer isn't ready
const TIME_TO_FINAL_BUCKETS = [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200, 21600, 86400];

/**
 * An instrument made on first use, from the meter provider registered then, and made again if
 * another one is registered later. The API has no proxy meter: an instrument made at import time,
 * before the SDK registers its provider, would stay a no-op forever (the tests register a provider
 * of their own for each test).
 */
function lazy<T>(make: (meter: Meter) => T): () => T {
  let provider: MeterProvider | undefined;
  let instrument: T | undefined;
  return () => {
    const current = metrics.getMeterProvider();
    if (instrument === undefined || current !== provider) {
      instrument = make(current.getMeter(METER_NAME));
      provider = current;
    }
    return instrument;
  };
}

export interface CounterInstrument {
  add(value: number, attributes?: Attributes): void;
}

export interface HistogramInstrument {
  record(value: number, attributes?: Attributes): void;
}

function counter(name: string, options: MetricOptions): CounterInstrument {
  const instrument = lazy((meter) => meter.createCounter(name, options));
  return { add: (value, attributes) => instrument().add(value, attributes) };
}

function histogram(name: string, options: MetricOptions): HistogramInstrument {
  const instrument = lazy((meter) => meter.createHistogram(name, options));
  return { record: (value, attributes) => instrument().record(value, attributes) };
}

// A value and its attributes
export type Point = readonly [number, Attributes];

/**
 * An observable gauge fed by a periodic task, like faclab-core's `ObservedValues`: the task replaces
 * the sample and every export reads the last one, so the database is only queried by the task.
 * Past `maxAgeMs` the sample is dropped, so a task that stopped running cuts the series instead of
 * freezing it.
 */
export class ObservedGauge {
  private points: readonly Point[] = [];
  private expiresAt = 0;
  private registeredWith: MeterProvider | undefined;

  constructor(
    readonly name: string,
    private readonly options: MetricOptions,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  replace(points: readonly Point[], maxAgeMs: number): void {
    this.points = points;
    this.expiresAt = this.clock() + maxAgeMs;
    this.register();
  }

  /** The sample an export reads: none once it is too old */
  observe(): readonly Point[] {
    return this.clock() > this.expiresAt ? [] : this.points;
  }

  // On the provider registered when the first sample arrives (see `lazy`)
  private register(): void {
    const provider = metrics.getMeterProvider();
    if (provider === this.registeredWith) return;
    this.registeredWith = provider;
    provider
      .getMeter(METER_NAME)
      .createObservableGauge(this.name, this.options)
      .addCallback((result: ObservableResult) => {
        for (const [value, attributes] of this.observe()) result.observe(value, attributes);
      });
  }
}

// --- SRI ---------------------------------------------------------------------------------------

export const sriRequestDuration = histogram('faclab.sri.request.duration', {
  description:
    'Duration of each call to the SRI web services, by faclab.sri.operation (recepcion, ' +
    'autorizacion), faclab.sri.outcome (ok, timeout, error) and faclab.sri.environment',
  unit: 's',
  advice: { explicitBucketBoundaries: SHORT_DURATION_BUCKETS },
});

export const invoiceRejections = counter('faclab.invoices.rejections', {
  description:
    'Documents the SRI rejected (DEVUELTA at reception, NO AUTORIZADO at authorization), by ' +
    'faclab.sri.message.code (the code of its first error) and faclab.sri.operation',
  unit: '{document}',
});

// --- The documents on their way -----------------------------------------------------------------

export const invoiceTransitions = counter('faclab.invoices.transitions', {
  description:
    'Status changes of the documents (saved), by from, to and faclab.document.type ' +
    '(invoice, credit_note)',
  unit: '{transition}',
});

export const invoiceTimeToFinal = histogram('faclab.invoices.time_to_final', {
  description:
    "From the sale's request (occurred_at of its message) to the SRI's answer, by result " +
    '(authorized, rejected) and faclab.document.type',
  unit: 's',
  advice: { explicitBucketBoundaries: TIME_TO_FINAL_BUCKETS },
});

export const invoiceStepDuration = histogram('faclab.invoices.step.duration', {
  description:
    'Duration of each step of a document, by faclab.invoice.step (prepare, sign, send, ' +
    'authorize), faclab.step.outcome (advanced, blocked, invalid, retry, conflict) and ' +
    'faclab.document.type',
  unit: 's',
  advice: { explicitBucketBoundaries: SHORT_DURATION_BUCKETS },
});

// Sampled by the worker's metrics task, across companies
export const invoicesPending = new ObservedGauge('faclab.invoices.pending', {
  description:
    'Documents not yet authorized nor rejected, by status, faclab.issue.type (the code of the ' +
    'problem that holds them, or none) and faclab.document.type',
  unit: '{document}',
});

export const invoicesOldestAge = new ObservedGauge('faclab.invoices.oldest_age', {
  description: 'Age of the oldest document not yet final, by status (0: none)',
  unit: 's',
});

export const invoicesDue = new ObservedGauge('faclab.invoices.due', {
  description: 'Documents in the queue whose turn came and that no worker holds',
  unit: '{document}',
});

export const invoicesExpiredLeases = new ObservedGauge('faclab.invoices.expired_leases', {
  description: 'Documents held by a worker whose lease ran out (a worker that died)',
  unit: '{document}',
});

// --- Delivery to the buyer ----------------------------------------------------------------------

export const DELIVERY_RESULTS = ['sent', 'bounced', 'retry', 'failed', 'no_recipient', 'disabled'];

export const invoiceDeliveries = counter('faclab.invoices.deliveries', {
  description:
    'Delivery attempts of authorized documents, by result: sent, bounced, retry (it failed and ' +
    'waits for the next attempt), failed (it spent its attempts), no_recipient, disabled',
  unit: '{delivery}',
});

export const invoicesPendingDeliveries = new ObservedGauge('faclab.invoices.pending_deliveries', {
  description: 'Deliveries waiting to be sent',
  unit: '{delivery}',
});

// --- Certificates -------------------------------------------------------------------------------

export const certificatesExpiring = new ObservedGauge('faclab.certificates.expiring', {
  description:
    'Signing certificates selected by the issuers, by window: expired, 7d (expires within 7 ' +
    'days), 30d (within 8 to 30 days)',
  unit: '{certificate}',
});

// --- Messaging (OTel messaging conventions, like faclab-core) -----------------------------------

export const messagingProcessDuration = histogram('messaging.process.duration', {
  description:
    "Duration of the consumer's handler per Kafka message and attempt; error.type when it failed",
  unit: 's',
  advice: { explicitBucketBoundaries: SHORT_DURATION_BUCKETS },
});

export const messagingSentMessages = counter('messaging.client.sent.messages', {
  description: 'Messages sent to Kafka; error.type on the ones that failed',
  unit: '{message}',
});

export const deadLettersPending = new ObservedGauge('faclab.dead_letters.pending', {
  description: 'Kafka messages the consumer kept in dead_letters, by topic',
  unit: '{message}',
});

// --- Counters that start at 0 (S7.6) ------------------------------------------------------------

/**
 * Exports 0 for every series an alert reads with `increase`, as soon as the worker starts: a series'
 * first point has nothing before it to increase from, so the first failed delivery after a restart
 * would not fire the alert. `faclab.invoices.rejections` can't be started like this: each SRI message
 * code opens a series of its own. Call it once the SDK registered its meter provider.
 */
export function initializeCounters(): void {
  for (const result of DELIVERY_RESULTS) invoiceDeliveries.add(0, { result });
}
