import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4317';

// Same resource attributes as faclab-core (docs/architecture/OBSERVABILITY.md §3)
const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'faclab-invoicing',
    'service.namespace': 'faclab',
    // Set at build time (tag or commit SHA)
    [ATTR_SERVICE_VERSION]: process.env.SERVICE_VERSION || 'dev',
    'deployment.environment.name': process.env.NODE_ENV || 'local',
  }),

  traceExporter: new OTLPTraceExporter({ url: endpoint }),

  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: endpoint }),
    exportIntervalMillis: 30_000,
  }),

  logRecordProcessor: new BatchLogRecordProcessor(new OTLPLogExporter({ url: endpoint })),

  instrumentations: [
    new HttpInstrumentation(),
    new AwsInstrumentation({ suppressInternalInstrumentation: true }),
    new PinoInstrumentation(),
  ],
});

sdk.start();

// Docker waits 10 s after SIGTERM before killing the process
const SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * Exports the spans, metrics and logs still buffered. Call it before `process.exit`, or the last
 * ones are lost. Gives up after a few seconds if the collector doesn't answer.
 */
export async function shutdownTelemetry(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
  });
  try {
    await Promise.race([sdk.shutdown(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
