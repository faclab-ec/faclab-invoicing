import { v4 as uuidv4 } from 'uuid';

import { Invoice, TraceContext } from './invoice';
import { retryAt } from './issue';
import { SaleData } from './sale';

// Created with the authorization, or by someone who asked to send it again
export type DeliveryKind = 'authorization' | 'resend';

export type DeliveryStatus =
  | 'pending'
  // The mail server accepted it
  | 'sent'
  // The mail server refused the address or the message: retrying gives the same answer
  | 'bounced'
  // Still failing after every automatic retry
  | 'failed'
  // The buyer has no (valid) email: only the RIDE was kept
  | 'no_recipient'
  // Sending is turned off (INVOICE_EMAIL_ENABLED=false): only the RIDE was kept
  | 'disabled';

export type DeliverySkip = Extract<DeliveryStatus, 'no_recipient' | 'disabled'>;

export interface InvoiceDeliveryProps {
  id: string;
  tenantId: string;
  invoiceId: string;
  kind: DeliveryKind;
  // The buyer's email when it was created; null when the sale has none
  recipient: string | null;
  // Who asked for a resend
  requestedBy: string | null;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
  smtpResponse: string | null;
  messageId: string | null;
  sentAt: Date | null;
  traceContext: TraceContext | null;
  createdAt: Date;
  updatedAt: Date;
}

// One address, as SMTP takes it: no lists, names nor spaces
const EMAIL_PATTERN = /^[^\s@,;<>"()[\]\\]+@[^\s@,;<>"()[\]\\]+\.[^\s@,;<>"()[\]\\]+$/;
const MAX_EMAIL_LENGTH = 254;

/** The email the invoice goes to: the buyer's, as the sale brought it; null if it has none */
export function buyerEmail(sale: SaleData | null): string | null {
  const email = sale?.customer?.email?.trim();
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return null;
  return email;
}

/**
 * The delivery of an authorized invoice to its buyer: its RIDE kept and, when the buyer has an
 * email, the RIDE and the authorized XML sent to it. Also the send log of the invoice.
 */
export class InvoiceDelivery {
  readonly id: string;
  readonly tenantId: string;
  readonly invoiceId: string;
  readonly kind: DeliveryKind;
  readonly recipient: string | null;
  readonly requestedBy: string | null;
  readonly traceContext: TraceContext | null;
  readonly createdAt: Date;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
  smtpResponse: string | null;
  messageId: string | null;
  sentAt: Date | null;
  updatedAt: Date;

  constructor(props: InvoiceDeliveryProps) {
    this.id = props.id;
    this.tenantId = props.tenantId;
    this.invoiceId = props.invoiceId;
    this.kind = props.kind;
    this.recipient = props.recipient;
    this.requestedBy = props.requestedBy;
    this.traceContext = props.traceContext;
    this.createdAt = props.createdAt;
    this.status = props.status;
    this.attempts = props.attempts;
    this.nextAttemptAt = props.nextAttemptAt;
    this.lastError = props.lastError;
    this.smtpResponse = props.smtpResponse;
    this.messageId = props.messageId;
    this.sentAt = props.sentAt;
    this.updatedAt = props.updatedAt;
  }

  /** The delivery the authorization of an invoice starts, due right away */
  static forAuthorization(
    invoice: Invoice,
    now: Date = new Date(),
    traceContext: TraceContext | null = null,
  ): InvoiceDelivery {
    return InvoiceDelivery.pending(invoice, 'authorization', null, now, traceContext);
  }

  /** Someone asked to send the invoice again: always to the buyer's email of the sale */
  static resend(
    invoice: Invoice,
    requestedBy: string,
    now: Date = new Date(),
    traceContext: TraceContext | null = null,
  ): InvoiceDelivery {
    return InvoiceDelivery.pending(invoice, 'resend', requestedBy, now, traceContext);
  }

  private static pending(
    invoice: Invoice,
    kind: DeliveryKind,
    requestedBy: string | null,
    now: Date,
    traceContext: TraceContext | null,
  ): InvoiceDelivery {
    return new InvoiceDelivery({
      id: uuidv4(),
      tenantId: invoice.tenantId,
      invoiceId: invoice.id,
      kind,
      recipient: buyerEmail(invoice.sale),
      requestedBy,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      lastError: null,
      smtpResponse: null,
      messageId: null,
      sentAt: null,
      traceContext,
      createdAt: now,
      updatedAt: now,
    });
  }

  get isPending(): boolean {
    return this.status === 'pending';
  }

  markSent(sent: { messageId: string; response: string }, now: Date = new Date()): void {
    this.finish('sent', now);
    this.messageId = sent.messageId;
    this.smtpResponse = sent.response;
    this.sentAt = now;
    this.lastError = null;
  }

  /** The mail server refused it for good: not retried */
  markBounced(response: string, now: Date = new Date()): void {
    this.attempts += 1;
    this.finish('bounced', now);
    this.smtpResponse = response;
    this.lastError = 'The mail server refused the message';
  }

  /** It may go through later: retried with a growing delay, then given up (`failed`) */
  recordFailure(error: string, now: Date = new Date()): void {
    this.attempts += 1;
    this.lastError = error;
    this.updatedAt = now;
    const next = retryAt(this.attempts, now);
    if (next) {
      this.nextAttemptAt = next;
    } else {
      this.finish('failed', now);
    }
  }

  /** Nothing to send: the RIDE is kept and the delivery ends */
  skip(reason: DeliverySkip, now: Date = new Date()): void {
    this.finish(reason, now);
  }

  private finish(status: DeliveryStatus, now: Date): void {
    if (!this.isPending) {
      throw new Error(`Delivery ${this.id} already ended (${this.status})`);
    }
    this.status = status;
    this.nextAttemptAt = null;
    this.updatedAt = now;
  }
}
