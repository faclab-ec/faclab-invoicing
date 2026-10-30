-- Up Migration

-- S4.2: `invoices` is also the work queue of the worker. `next_attempt_at` says when the worker
-- has something to do with an invoice (its next step, or telling faclab-core the result) and the
-- lease who holds it meanwhile; `result_published_at` when the result went out on `invoices`, and
-- `trace_context` the W3C context of the message that brought the sale, which its jobs continue
ALTER TABLE invoices
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN locked_by text,
  ADD COLUMN result_published_at timestamptz,
  ADD COLUMN trace_context jsonb;

-- Invoices in flight without an issue were moving through the `invoices` topic: due now
UPDATE invoices SET next_attempt_at = now()
  WHERE status IN ('pending', 'created', 'signed', 'sent') AND issue_code IS NULL;
-- The previous version published every result as it happened
UPDATE invoices SET result_published_at = updated_at, next_attempt_at = NULL
  WHERE status IN ('authorized', 'rejected');

-- What the worker polls: only the invoices with something to do
CREATE INDEX ix_invoices_next_attempt_at ON invoices (next_attempt_at)
  WHERE next_attempt_at IS NOT NULL;

-- Down Migration

DROP INDEX ix_invoices_next_attempt_at;
-- The previous version clears the date of an invoice that moved on: it expects one only with an issue
UPDATE invoices SET next_attempt_at = NULL WHERE issue_code IS NULL;
ALTER TABLE invoices
  DROP COLUMN trace_context,
  DROP COLUMN result_published_at,
  DROP COLUMN locked_by,
  DROP COLUMN locked_until;
