import { TraceContext } from './invoice';
import { InvoiceIssueCode } from './issue';

/** An invoice a worker took from the queue */
export interface ClaimedInvoice {
  id: string;
  // The trace its job continues
  traceContext: TraceContext | null;
}

/** An invoice in flight that isn't due: it waits for its issuer, a manual retry or a later attempt */
export interface WaitingInvoice {
  id: string;
  tenantId: string;
  // The RUC the sale was made with (null in a v1 message)
  issuerRuc: string | null;
  issueCode: InvoiceIssueCode | null;
  nextAttemptAt: Date | null;
}

/**
 * The `invoices` table as a work queue. An invoice is due once its `nextAttemptAt` has passed; a
 * worker that takes it holds a lease until it lets it go or the lease runs out, so another worker
 * (or the same one, restarted) takes it again only after that. Each slot of a worker is a holder of
 * its own. Nothing here changes the invoice's version: a step in progress still saves over it.
 */
export interface InvoiceQueue {
  /** Takes up to `limit` due invoices nobody holds, oldest due first (`FOR UPDATE SKIP LOCKED`) */
  claimDue(holder: string, leaseMs: number, limit: number): Promise<ClaimedInvoice[]>;
  /** Takes this invoice whether it is due or not, unless someone else holds it */
  claim(id: string, holder: string, leaseMs: number): Promise<boolean>;
  /** Extends the holder's lease; false once it lost it to another holder */
  renew(id: string, holder: string, leaseMs: number): Promise<boolean>;
  /** Lets the invoice go, if the holder still has it */
  release(id: string, holder: string): Promise<void>;
  /** When the queue gives the invoice out again */
  postpone(id: string, at: Date): Promise<void>;
  /** The invoices in flight that aren't due, of one company or of all */
  findWaiting(tenantId?: string): Promise<WaitingInvoice[]>;
  /** Makes these invoices due at `at`, unless they are final or due earlier: how many it changed */
  requeue(ids: string[], at: Date): Promise<number>;
}
