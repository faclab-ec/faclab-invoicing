import { AccessCode } from './access-code';
import { InvoiceDomainEvent, InvoiceStatus, STATUS_EVENT_TYPE } from './events';
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

export interface InvoiceProps {
  id: string;
  saleId: string;
  point: IssuingPoint;
  status: InvoiceStatus;
  sale: SaleData | null;
  accessCode: AccessCode | null;
  sequence: string | null;
  signatureId: string | null;
  xml: string | null;
  statusHistory: InvoiceStatusHistory[];
  issue: InvoiceIssue | null;
  attempts: number;
  nextAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

const FINAL_STATUSES = [InvoiceStatus.AUTHORIZED, InvoiceStatus.REJECTED];

export class Invoice {
  private _domainEvents: InvoiceDomainEvent[] = [];

  readonly id: string;
  readonly saleId: string;
  // Company, establishment and emission point that issue it, as the sale says
  readonly point: IssuingPoint;
  // Kept so the XML can be built whenever the issuer is ready
  readonly sale: SaleData | null;
  readonly statusHistory: InvoiceStatusHistory[];
  readonly createdAt: Date;
  // Optimistic lock: the repository only saves over the version it read
  version: number;

  private _status: InvoiceStatus;
  private _accessCode: AccessCode | null;
  private _sequence: string | null;
  private _signatureId: string | null;
  private _xml: string | null;
  private _issue: InvoiceIssue | null;
  private _attempts: number;
  private _nextAttemptAt: Date | null;
  private _updatedAt: Date;

  constructor(props: InvoiceProps) {
    this.id = props.id;
    this.saleId = props.saleId;
    this.point = props.point;
    this.sale = props.sale;
    this.statusHistory = props.statusHistory;
    this.createdAt = props.createdAt;
    this.version = props.version;
    this._status = props.status;
    this._accessCode = props.accessCode;
    this._sequence = props.sequence;
    this._signatureId = props.signatureId;
    this._xml = props.xml;
    this._issue = props.issue;
    this._attempts = props.attempts;
    this._nextAttemptAt = props.nextAttemptAt;
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

  get signatureId(): string | null {
    return this._signatureId;
  }

  get xml(): string | null {
    return this._xml;
  }

  /** Why the last attempt couldn't move the invoice forward; cleared when it does */
  get issue(): InvoiceIssue | null {
    return this._issue;
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | null {
    return this._nextAttemptAt;
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

  static receive(id: string, point: IssuingPoint, sale: SaleData, now: Date = new Date()): Invoice {
    const invoice = new Invoice({
      id,
      saleId: String(sale.sale_id),
      point,
      status: InvoiceStatus.PENDING,
      sale,
      accessCode: null,
      sequence: null,
      signatureId: null,
      xml: null,
      statusHistory: [],
      issue: null,
      attempts: 0,
      nextAttemptAt: null,
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

  /** The sequence is used up once assigned: a retry of `prepare` keeps it */
  assignSequence(sequence: string): void {
    this.assertStatus(InvoiceStatus.PENDING, 'assign a sequence to');
    if (this._sequence !== null) {
      throw new Error(`Invoice ${this.id} already has sequence ${this._sequence}`);
    }
    this._sequence = sequence;
    this._updatedAt = new Date();
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

  authorize(messages: string[]): void {
    this.assertStatus(InvoiceStatus.SENT, 'authorize');
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

  pullEvents(): InvoiceDomainEvent[] {
    const events = [...this._domainEvents];
    this._domainEvents = [];
    return events;
  }

  private assertStatus(expected: InvoiceStatus, action: string): void {
    if (this._status !== expected) {
      throw new Error(`Cannot ${action} invoice in status ${this._status}`);
    }
  }

  private addStatusHistory(status: InvoiceStatus, date: Date, description?: string): void {
    this._status = status;
    this._issue = null;
    this._attempts = 0;
    this._nextAttemptAt = null;
    this._updatedAt = date;
    this.statusHistory.push(new InvoiceStatusHistory(status, date, description));
    this._domainEvents.push({
      type: STATUS_EVENT_TYPE[status],
      tenantId: this.tenantId,
      invoiceId: this.id,
      saleId: this.saleId,
      status,
      occurredAt: date,
    } as InvoiceDomainEvent);
  }
}
