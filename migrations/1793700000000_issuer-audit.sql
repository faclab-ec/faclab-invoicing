-- Up Migration

-- S8.5: the audit of what changes a company's issuer in a way that can't be taken back, today the
-- step from the SRI's test environment to production (`issuer.production_enabled`). Append-only: a
-- trigger refuses UPDATE and DELETE whatever the role, like faclab-core's audit log. `actor_id` is
-- the `sub` of the token (a user of faclab-core), `actor_name` its username.
CREATE TABLE issuer_audit (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  action text NOT NULL,
  actor_id text NOT NULL,
  actor_name text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_issuer_audit_tenant ON issuer_audit (tenant_id, occurred_at);

CREATE FUNCTION issuer_audit_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'issuer_audit is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER issuer_audit_append_only
  BEFORE UPDATE OR DELETE ON issuer_audit
  FOR EACH ROW EXECUTE FUNCTION issuer_audit_append_only();

-- Down Migration

DROP TRIGGER issuer_audit_append_only ON issuer_audit;
DROP FUNCTION issuer_audit_append_only();
DROP TABLE issuer_audit;
