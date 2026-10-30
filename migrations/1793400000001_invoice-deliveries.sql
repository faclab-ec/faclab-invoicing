-- Up Migration

-- S4.4: the delivery of each authorized invoice to its buyer, and the send log. A row is created
-- with the authorization, in the same transaction (kind `authorization`), and by each resend
-- (`resend`, who asked in `requested_by`). The worker takes the pending ones like the invoices
-- (`next_attempt_at`, `locked_until`/`locked_by`, FOR UPDATE SKIP LOCKED): it makes sure the RIDE
-- is kept and emails it with the authorized XML to `recipient`, the buyer's email of the sale.
-- Ends `sent`, `bounced` (the mail server refused the address), `failed` (retries exhausted),
-- `no_recipient` (the buyer has no email: only the RIDE) or `disabled` (sending turned off)
CREATE TABLE invoice_deliveries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  invoice_id uuid NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('authorization', 'resend')),
  recipient text,
  requested_by text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'bounced', 'failed', 'no_recipient', 'disabled')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  locked_until timestamptz,
  locked_by text,
  last_error text,
  -- What the mail server answered: accepted, or why it refused
  smtp_response text,
  message_id text,
  sent_at timestamptz,
  trace_context jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT ck_invoice_deliveries_due CHECK (status <> 'pending' OR next_attempt_at IS NOT NULL)
);

-- One delivery per authorization: a retried authorization step doesn't email twice
CREATE UNIQUE INDEX uq_invoice_deliveries_authorization
  ON invoice_deliveries (invoice_id) WHERE kind = 'authorization';
-- At most one pending per invoice: a second resend gets the one already waiting
CREATE UNIQUE INDEX uq_invoice_deliveries_pending
  ON invoice_deliveries (invoice_id) WHERE status = 'pending';
CREATE INDEX ix_invoice_deliveries_due
  ON invoice_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX ix_invoice_deliveries_invoice
  ON invoice_deliveries (tenant_id, invoice_id, created_at DESC);

-- Down Migration

DROP TABLE invoice_deliveries;
