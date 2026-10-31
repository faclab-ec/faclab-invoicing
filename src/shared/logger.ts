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

export interface LoggerConfig {
  level: string;
  serviceName: string;
  serviceVersion: string;
  environment: string;
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
