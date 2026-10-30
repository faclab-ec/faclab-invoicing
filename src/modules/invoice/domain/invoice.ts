import { AccessCode } from './access-code';
import { generateNumericCode } from './access-code-generator';
import { InvoiceResultEvent, InvoiceStatus } from './events';
import { InvoiceIssue, nextAttemptAt } from './issue';
import { IssuingPoint, SaleData } from './sale';

export { InvoiceStatus } from './events';

export class InvoiceStatusHistory {
  constructor(
    public name: InvoiceStatus,
    public statusDate: Date,
    public description?: string,
  ) {}
}

// W3C trace context (traceparent, tracestate) of the message that brought the sale: the worker
// continues its trace
export type TraceContext = Record<string, string>;

export interface InvoiceProps {
  id: string;
  saleId: string;
  point: IssuingPoint;
  status: InvoiceStatus;
  sale: SaleData | null;
  // When faclab-core asked to invoice the sale (`occurred_at` of sales.confirmed): its confirmation,
  // or a resend. Null in invoices received before S4.1
  requestedAt: Date | null;
  accessCode: AccessCode | null;
  sequence: string | null;
  numericCode: string | null;
  signatureId: string | null;
  xml: string | null;
  authorization: InvoiceAuthorization | null;
  statusHistory: InvoiceStatusHistory[];
  issue: InvoiceIssue | null;
  attempts: number;
  nextAttemptAt: Date | null;
  // When faclab-core was told the result (`invoices`); null until then, and before final
  resultPublishedAt: Date | null;
  traceContext: TraceContext | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

/** What the SRI answered when it authorized the invoice, and where its authorized XML is kept */
export interface InvoiceAuthorization {
  number: string;
  authorizedAt: Date;
  // Key of the authorized XML in the document storage
  xmlKey: string;
}

const FINAL_STATUSES = [InvoiceStatus.AUTHORIZED, InvoiceStatus.REJECTED];

export class Invoice {
  readonly id: string;
  readonly saleId: string;
  // Company, establishment and emission point that issue it, as the sale says
  readonly point: IssuingPoint;
  // Kept so the XML can be built whenever the issuer is ready
  readonly sale: SaleData | null;
  readonly requestedAt: Date | null;
  readonly traceContext: TraceContext | null;
  readonly statusHistory: InvoiceStatusHistory[];
  readonly createdAt: Date;
  // Optimistic lock: the repository only saves over the version it read
  version: number;

  private _status: InvoiceStatus;
  private _accessCode: AccessCode | null;
  private _sequence: string | null;
  private _numericCode: string | null;
  private _signatureId: string | null;
  private _xml: string | null;
  private _authorization: InvoiceAuthorization | null;
  private _issue: InvoiceIssue | null;
  private _attempts: number;
  private _nextAttemptAt: Date | null;
  private _resultPublishedAt: Date | null;
  private _updatedAt: Date;

  constructor(props: InvoiceProps) {
    this.id = props.id;
    this.saleId = props.saleId;
    this.point = props.point;
    this.sale = props.sale;
    this.requestedAt = props.requestedAt;
    this.traceContext = props.traceContext;
    this.statusHistory = props.statusHistory;
    this.createdAt = props.createdAt;
    this.version = props.version;
    this._status = props.status;
    this._accessCode = props.accessCode;
    this._sequence = props.sequence;
    this._numericCode = props.numericCode;
    this._signatureId = props.signatureId;
    this._xml = props.xml;
    this._authorization = props.authorization;
    this._issue = props.issue;
    this._attempts = props.attempts;
    this._nextAttemptAt = props.nextAttemptAt;
    this._resultPublishedAt = props.resultPublishedAt;
    this._updatedAt = props.updatedAt;
  }

  get tenantId(): string {
    return this.point.tenantId;
  }

  get status(): InvoiceStatus {
    return this._status;
  }

  get accessCode(): AccessCode | null {
    return this._accessCode;
  }

  get sequence(): string | null {
    return this._sequence;
  }

  /** The 8 digits of the access code chosen by the issuer: assigned with the sequence */
  get numericCode(): string | null {
    return this._numericCode;
  }

  get signatureId(): string | null {
    return this._signatureId;
  }

  get xml(): string | null {
    return this._xml;
  }

  /** Set once the SRI authorizes it */
  get authorization(): InvoiceAuthorization | null {
    return this._authorization;
  }

  /** Why the last attempt couldn't move the invoice forward; cleared when it does */
  get issue(): InvoiceIssue | null {
    return this._issue;
  }

  get attempts(): number {
    return this._attempts;
  }

  /**
   * When the worker takes it next: its next step, or telling faclab-core the result. Null while it
   * waits for its issuer or a manual retry, and once done
   */
  get nextAttemptAt(): Date | null {
    return this._nextAttemptAt;
  }

  get resultPublishedAt(): Date | null {
    return this._resultPublishedAt;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  get isFinal(): boolean {
    return FINAL_STATUSES.includes(this._status);
  }

  /** A sale has at most one active invoice: a new one only after a rejection */
  get isActive(): boolean {
    return this._status !== InvoiceStatus.REJECTED;
  }

  /** Not finished and either stuck on a problem or still waiting to start */
  get needsAttention(): boolean {
    return !this.isFinal && (this._issue !== null || this._status === InvoiceStatus.PENDING);
  }

  static receive(
    id: string,
    point: IssuingPoint,
    sale: SaleData,
    now: Date = new Date(),
    requestedAt: Date | null = null,
    traceContext: TraceContext | null = null,
  ): Invoice {
    const invoice = new Invoice({
      id,
      saleId: String(sale.sale_id),
      point,
      status: InvoiceStatus.PENDING,
      sale,
      requestedAt,
      accessCode: null,
      sequence: null,
      numericCode: null,
      signatureId: null,
      xml: null,
      authorization: null,
      statusHistory: [],
      issue: null,
      attempts: 0,
      nextAttemptAt: null,
      resultPublishedAt: null,
      traceContext,
      createdAt: now,
      updatedAt: now,
      version: 0,
    });
    invoice.addStatusHistory(InvoiceStatus.PENDING, now, 'Sale received');
    return invoice;
  }

  requireXml(): string {
    if (this._xml === null) throw new Error(`Invoice ${this.id} has no XML yet`);
    return this._xml;
  }

  requireAccessCode(): AccessCode {
    if (this._accessCode === null) throw new Error(`Invoice ${this.id} has no access code yet`);
    return this._accessCode;
  }

  /**
   * The sequence is used up once assigned: a retry of `prepare` keeps it, and the random numeric
   * code of its access code with it
   */
  assignSequence(sequence: string, numericCode: string = generateNumericCode()): void {
    this.assertStatus(InvoiceStatus.PENDING, 'assign a sequence to');
    if (this._sequence !== null) {
      throw new Error(`Invoice ${this.id} already has sequence ${this._sequence}`);
    }
    this._sequence = sequence;
    this._numericCode = numericCode;
    this._updatedAt = new Date();
  }

  requireNumericCode(): string {
    if (this._numericCode === null) throw new Error(`Invoice ${this.id} has no numeric code yet`);
    return this._numericCode;
  }

  prepare(props: { accessCode: AccessCode; signatureId: string; xml: string }): void {
    this.assertStatus(InvoiceStatus.PENDING, 'prepare');
    if (this._sequence === null) {
      throw new Error(`Cannot prepare invoice ${this.id} without a sequence`);
    }
    this._accessCode = props.accessCode;
    this._signatureId = props.signatureId;
    this._xml = props.xml;
    this.addStatusHistory(InvoiceStatus.CREATED, new Date(), 'XML created');
  }

  sign(signedXml: string): void {
    this.assertStatus(InvoiceStatus.CREATED, 'sign');
    this._xml = signedXml;
    this.addStatusHistory(InvoiceStatus.SIGNED, new Date(), 'XML signed');
  }

  markAsSent(messages: string[]): void {
    this.assertStatus(InvoiceStatus.SIGNED, 'send');
    this.addStatusHistory(InvoiceStatus.SENT, new Date(), messages.join(' >> '));
  }

  authorize(authorization: InvoiceAuthorization, messages: string[]): void {
    this.assertStatus(InvoiceStatus.SENT, 'authorize');
    this._authorization = authorization;
    this.addStatusHistory(InvoiceStatus.AUTHORIZED, new Date(), messages.join(' >> '));
  }

  reject(messages: string[]): void {
    if (this.isFinal) {
      throw new Error(`Cannot reject invoice in status ${this._status}`);
    }
    this.addStatusHistory(InvoiceStatus.REJECTED, new Date(), messages.join(' >> '));
  }

  /** The current step failed: keep the status and remember why */
  recordIssue(issue: InvoiceIssue): void {
    if (this.isFinal) {
      throw new Error(`Cannot record an issue on invoice in status ${this._status}`);
    }
    this._issue = issue;
    this._attempts += 1;
    this._nextAttemptAt = nextAttemptAt(issue.code, this._attempts, issue.at);
    this._updatedAt = issue.at;
  }

  /** The SRI's answer, for faclab-core: null until the invoice is authorized or rejected */
  resultEvent(): InvoiceResultEvent | null {
    if (!this.isFinal) return null;
    const last = this.statusHistory[this.statusHistory.length - 1];
    const base = {
      tenantId: this.tenantId,
      invoiceId: this.id,
      saleId: this.saleId,
      status: this._status,
      occurredAt: last.statusDate,
    };
    if (this._status === InvoiceStatus.AUTHORIZED) return { ...base, type: 'InvoiceAuthorized' };
    // A rejection carries the SRI's messages (invoices v1 `reason`)
    return { ...base, type: 'InvoiceRejected', reason: last.description || null };
  }

  /**
   * faclab-core asked again for an invoice the SRI already authorized (it resent the sale): it may
   * have lost the result, so the worker publishes it again, right away. True if it changed: an
   * invoice whose result is still to go out has nothing to add
   */
  publishResultAgain(at: Date = new Date()): boolean {
    if (this._status !== InvoiceStatus.AUTHORIZED || this._resultPublishedAt === null) return false;
    this._resultPublishedAt = null;
    this._nextAttemptAt = at;
    this._updatedAt = at;
    return true;
  }

  /** faclab-core has the result: nothing is left to do with the invoice */
  markResultPublished(at: Date = new Date()): void {
    if (!this.isFinal) {
      throw new Error(`Invoice ${this.id} has no result yet (status ${this._status})`);
    }
    this._resultPublishedAt = at;
    this._nextAttemptAt = null;
  }

  private assertStatus(expected: InvoiceStatus, action: string): void {
    if (this._status !== expected) {
      throw new Error(`Cannot ${action} invoice in status ${this._status}`);
    }
  }

  // Due right away: the worker runs the next step, or publishes the result once final
  private addStatusHistory(status: InvoiceStatus, date: Date, description?: string): void {
    this._status = status;
    this._issue = null;
    this._attempts = 0;
    this._nextAttemptAt = date;
    this._updatedAt = date;
    this.statusHistory.push(new InvoiceStatusHistory(status, date, description));
  }
}
