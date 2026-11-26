import { isSpanContextValid, trace } from '@opentelemetry/api';
import pino from 'pino';

let logger: pino.Logger = pino({ level: 'silent' });

// Keys whose value never reaches a log, compared without case, "_" or "-". Same list as
// faclab-core (docs/architecture/OBSERVABILITY.md §4.6)
const SENSITIVE_KEYS = new Set([
  'password',
  'currentpassword',
  'newpassword',
  'secret',
  'jwtsecret',
  'clientsecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'cookie',
  'setcookie',
  'apikey',
  'p12',
  'certificate',
  'privatekey',
  'xml',
  'signature',
  // Personal data of the buyers (S4.4): never in the logs
  'email',
  'recipient',
  'replyto',
  'smtppassword',
  // Personal data of the buyers and issuers (S8.7, LOPDP): never in the logs. Not `name`: the
  // issuer's trade name and a certificate's file name are not a person's
  'taxid',
  'address',
  'phone',
  'customer',
  'buyer',
  'identification',
  'fullname',
]);
const REDACTED = '[REDACTED]';

const isSensitive = (key: string) => SENSITIVE_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''));

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * Masks passwords, tokens, secrets, certificates and signed XML at any depth of plain objects and
 * arrays. Anything else (an Error, a request) is left for pino's serializers.
 */
export function redactSensitive(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value) || isPlainObject(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, seen));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        isSensitive(key) ? REDACTED : redactSensitive(item, seen),
      ]),
    );
  }
  return value;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// A cédula (10 digits), a RUC (13) or an access code (49) quoted in a message
const IDENTIFICATION = /\b\d{10}(?:\d{3})?\b|\b\d{49}\b/g;

/**
 * An error's text without the data it may quote: the SRI, the XSD and zod repeat the value that
 * failed, and that can be a buyer's email, cédula or RUC (S8.7). Emails go whole, identifications
 * keep their first two and last two digits (OBSERVABILITY.md §4.6).
 */
export function scrubMessage(text: string): string {
  return text
    .replace(EMAIL, '[email]')
    .replace(
      IDENTIFICATION,
      (id) => `${id.slice(0, 2)}${'*'.repeat(id.length - 4)}${id.slice(-2)}`,
    );
}

const scrubError = (error: Error) => {
  const serialized = pino.stdSerializers.err(error);
  return {
    ...serialized,
    message: scrubMessage(serialized.message),
    stack: serialized.stack ? scrubMessage(serialized.stack) : serialized.stack,
  };
};

export interface LoggerConfig {
  level: string;
  serviceName: string;
  serviceVersion: string;
  environment: string;
}

/**
 * The active span's ids, so each log can be found from its trace and the other way round
 * (docs/architecture/OBSERVABILITY.md §4.1). Same keys and format as instrumentation-pino, whose own
 * correlation is off (`disableLogCorrelation`): this one also works where the instrumentation isn't
 * loaded, such as the tests.
 */
export function traceFields(): Record<string, string> {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (!spanContext || !isSpanContextValid(spanContext)) return {};
  return {
    trace_id: spanContext.traceId,
    span_id: spanContext.spanId,
    trace_flags: `0${spanContext.traceFlags.toString(16)}`,
  };
}

/** `destination` replaces stdout (tests); without it local logs go through pino-pretty. */
export function initLogger(config: LoggerConfig, destination?: pino.DestinationStream) {
  const pretty = config.environment === 'local' && !destination;

  const options: pino.LoggerOptions = {
    level: config.level,
    base:
      config.environment === 'local'
        ? undefined
        : {
            'service.name': config.serviceName,
            'service.version': config.serviceVersion,
            'deployment.environment.name': config.environment,
          },
    timestamp: pino.stdTimeFunctions.isoTime,
    mixin: traceFields,
    serializers: { err: scrubError },
    // Runs before serializing, so it also covers what instrumentation-pino sends over OTLP
    formatters: {
      log: (object) => redactSensitive(object) as Record<string, unknown>,
    },
    ...(pretty && {
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
        },
      },
    }),
  };

  logger = destination ? pino(options, destination) : pino(options);

  return logger;
}

export { logger };
