-- Up Migration

-- S6.3: the public API (/api/v1/invoices). Each document keeps the id of its sale's branch in
-- faclab-core (`branch_id` of sales.confirmed v3 and credit_notes.requested v2), so an
-- integration client limited to some branches only sees theirs. Documents received before it
-- have none: only a client without a branch limit sees them.
ALTER TABLE invoices ADD COLUMN branch_id integer;
CREATE INDEX ix_invoices_tenant_branch ON invoices (tenant_id, branch_id);
-- Integrations sync with `updatedSince`, ordered by updated_at and id
CREATE INDEX ix_invoices_tenant_updated_at ON invoices (tenant_id, updated_at, id);

-- The public API's rate limit counters (D-6, like faclab-core's): the GCRA's theoretical arrival
-- time of each key (a client or a company), in seconds since the epoch. A key whose time passed
-- says nothing more than no row: the worker deletes them
CREATE TABLE api_rate_limits (
  key text PRIMARY KEY,
  tat double precision NOT NULL
);

-- Down Migration

DROP TABLE api_rate_limits;
DROP INDEX ix_invoices_tenant_updated_at;
DROP INDEX ix_invoices_tenant_branch;
ALTER TABLE invoices DROP COLUMN branch_id;
