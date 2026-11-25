import { Span, SpanStatusCode } from '@opentelemetry/api';

import { scrubMessage } from '#/shared/logger';

/**
 * Marks a span failed with the error's type and its text scrubbed of emails and identifications
 * (S8.7): the message of an SRI, XSD or validation error can quote a buyer's data, and spans leave
 * the service.
 */
export function failSpan(span: Span, error: unknown): void {
  const err = error instanceof Error ? error : new Error(String(error));
  span.setStatus({ code: SpanStatusCode.ERROR, message: scrubMessage(err.message) });
  span.addEvent('exception', {
    'exception.type': err.name,
    'exception.message': scrubMessage(err.message),
    ...(err.stack ? { 'exception.stacktrace': scrubMessage(err.stack) } : {}),
  });
}
