-- Up Migration

-- S8.7: the termination of a company's contract (LOPDP, tax retention). faclab-core cancels the
-- company and runs its own steps; here the operator runs the same ones with the company's RUC
-- (`npm run cli -- tenant-...`): start (grace period), anonymize (what tax law doesn't need goes,
-- the buyers' personal data outside the signed documents is cleared) and purge (everything of the
-- company, after the tax retention). One row per company: the dates and who did each step.
CREATE TABLE tenant_offboarding (
  tenant_id uuid PRIMARY KEY,
  started_at timestamptz NOT NULL,
  started_by text NOT NULL,
  grace_ends_at timestamptz NOT NULL,
  retention_ends_at timestamptz NOT NULL,
  anonymized_at timestamptz,
  anonymized_by text,
  -- Kept after the purge: the proof that the company's data was erased, and when
  purged_at timestamptz,
  purged_by text
);

-- issuer_audit stays append-only for the service. The offboarding runs inside a transaction that
-- sets `faclab.offboarding = 'on'` (SET LOCAL): then its entries of that company may be
-- anonymized or deleted. Nothing else of the service sets it
CREATE OR REPLACE FUNCTION issuer_audit_append_only() RETURNS trigger AS $$
BEGIN
  IF current_setting('faclab.offboarding', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'issuer_audit is append-only';
END;
$$ LANGUAGE plpgsql;

-- Down Migration

CREATE OR REPLACE FUNCTION issuer_audit_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'issuer_audit is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TABLE tenant_offboarding;
