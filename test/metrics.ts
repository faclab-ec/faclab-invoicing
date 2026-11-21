import { Attributes, metrics } from '@opentelemetry/api';
import { metrics as sdk } from '@opentelemetry/sdk-node';
import { afterEach, beforeEach } from 'vitest';

/** A reader the test collects by hand; counters and histograms as deltas */
class TestReader extends sdk.MetricReader {
  constructor() {
    super({ aggregationTemporalitySelector: () => sdk.AggregationTemporality.DELTA });
  }

  protected async onForceFlush(): Promise<void> {}

  protected async onShutdown(): Promise<void> {}
}

export interface RecordedPoint {
  name: string;
  unit: string;
  attributes: Attributes;
  // A counter's sum or a gauge's value; for a histogram, how many it recorded
  value: number;
  // A histogram's sum, min and max
  histogram?: { sum: number; min?: number; max?: number };
}

const matches = (attributes: Attributes, wanted: Attributes) =>
  Object.entries(wanted).every(([key, value]) => attributes[key] === value);

export class RecordedPoints extends Array<RecordedPoint> {
  /** The points of a metric, optionally only those with these attributes */
  of(name: string, attributes: Attributes = {}): RecordedPoint[] {
    return this.filter((point) => point.name === name && matches(point.attributes, attributes));
  }

  /** What a counter added, or how many a histogram recorded, with these attributes */
  total(name: string, attributes: Attributes = {}): number {
    return this.of(name, attributes).reduce((total, point) => total + point.value, 0);
  }

  names(): string[] {
    return [...new Set(this.map((point) => point.name))].sort();
  }
}

/**
 * A meter provider of its own for each test, read in memory, like faclab-core's
 * `recorded_metrics`: `collect()` gives what was recorded since the previous collection.
 */
export function useRecordedMetrics() {
  let reader: TestReader;

  beforeEach(() => {
    metrics.disable();
    reader = new TestReader();
    metrics.setGlobalMeterProvider(new sdk.MeterProvider({ readers: [reader] }));
  });

  afterEach(() => {
    metrics.disable();
  });

  return {
    async collect(): Promise<RecordedPoints> {
      const { resourceMetrics, errors } = await reader.collect();
      if (errors.length > 0) throw errors[0];
      const points = new RecordedPoints();
      for (const scope of resourceMetrics.scopeMetrics) {
        for (const metric of scope.metrics) {
          for (const point of metric.dataPoints) {
            const { value } = point;
            const base = {
              name: metric.descriptor.name,
              unit: metric.descriptor.unit,
              attributes: point.attributes,
            };
            if (typeof value === 'number') {
              points.push({ ...base, value });
            } else if (value && typeof value === 'object' && 'count' in value) {
              const { count, sum, min, max } = value as {
                count: number;
                sum?: number;
                min?: number;
                max?: number;
              };
              points.push({ ...base, value: count, histogram: { sum: sum ?? 0, min, max } });
            }
          }
        }
      }
      return points;
    },
  };
}
