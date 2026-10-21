-- Up Migration

-- Signing certificates. The .p12 and its password are kept encrypted with
-- CERTIFICATE_PASSWORD_KEY (AES-256-GCM, `v1:<base64(iv | tag | data)>`)
CREATE TABLE certificates (
  id uuid PRIMARY KEY,
  serial_number text NOT NULL,
  subject text NOT NULL,
  issuer text NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz NOT NULL,
  file_name text NOT NULL,
  p12_ciphertext text NOT NULL,
  password_ciphertext text,
  uploaded_at timestamptz NOT NULL
);

CREATE INDEX ix_certificates_serial_number ON certificates (serial_number);

-- The fiscal profile of the issuer: a single row ('default') until invoicing is multi-company (S2.8)
CREATE TABLE issuers (
  id text PRIMARY KEY,
  tax_id text NOT NULL,
  name text NOT NULL,
  trade_name text NOT NULL,
  main_address text NOT NULL,
  branch_address text NOT NULL,
  branch_code text NOT NULL,
  sale_point_code text NOT NULL,
  special_taxpayer_resolution text,
  withholding_agent_resolution text,
  accounting_required boolean NOT NULL,
  environment smallint NOT NULL,
  emission_type smallint NOT NULL,
  signing_cert_id uuid REFERENCES certificates (id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL
);

-- Last number issued per document type ('01' = factura). Still global: S2.8 adds the company,
-- establishment and emission point
CREATE TABLE sequences (
  doc_type text PRIMARY KEY,
  last_value bigint NOT NULL CHECK (last_value >= 0)
);

INSERT INTO sequences (doc_type, last_value) VALUES ('01', 0);

CREATE TABLE invoices (
  id uuid PRIMARY KEY,
  sale_id text NOT NULL,
  status text NOT NULL
    CHECK (status IN ('pending', 'created', 'signed', 'sent', 'authorized', 'rejected')),
  -- The sale as received in `sales.confirmed`, kept until the XML is built
  sale jsonb,
  access_code text,
  sequence text,
  signature_id uuid,
  xml text,
  issue_code text,
  issue_message text,
  issue_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  -- Optimistic lock: an update only applies over the version it read
  version integer NOT NULL
);

-- A sale has at most one active invoice: a new one only after a rejection
CREATE UNIQUE INDEX uq_invoices_active_sale ON invoices (sale_id) WHERE status <> 'rejected';
CREATE INDEX ix_invoices_sale_id ON invoices (sale_id);
CREATE INDEX ix_invoices_status_created_at ON invoices (status, created_at);
CREATE INDEX ix_invoices_created_at ON invoices (created_at DESC, id DESC);

-- Status history of each invoice, in order (append-only)
CREATE TABLE invoice_events (
  invoice_id uuid NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  position integer NOT NULL,
  status text NOT NULL,
  occurred_at timestamptz NOT NULL,
  description text NOT NULL DEFAULT '',
  PRIMARY KEY (invoice_id, position)
);

-- Down Migration

DROP TABLE invoice_events;
DROP TABLE invoices;
DROP TABLE sequences;
DROP TABLE issuers;
DROP TABLE certificates;
