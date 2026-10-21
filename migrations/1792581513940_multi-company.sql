-- Up Migration

-- Invoicing becomes multi-company (S2.8): each company (faclab-core tenant) has its fiscal
-- profile, its certificates and its sequences per establishment and emission point. The rows of
-- the single issuer ('default') belong to no company and there is no production data, so the
-- tables start again empty.
DROP TABLE invoice_events;
DROP TABLE invoices;
DROP TABLE sequences;
DROP TABLE issuers;
DROP TABLE certificates;

-- Signing certificates of a company. The .p12 and its password are kept encrypted with
-- CERTIFICATE_PASSWORD_KEY (AES-256-GCM, `v1:<base64(iv | tag | data)>`)
CREATE TABLE certificates (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  serial_number text NOT NULL,
  subject text NOT NULL,
  issuer text NOT NULL,
  -- RUCs and cédulas found in the certificate: one of them is the issuer's RUC
  tax_ids text[] NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz NOT NULL,
  file_name text NOT NULL,
  p12_ciphertext text NOT NULL,
  password_ciphertext text,
  uploaded_at timestamptz NOT NULL,
  CONSTRAINT uq_certificates_tenant_id_id UNIQUE (tenant_id, id)
);

CREATE INDEX ix_certificates_tenant_uploaded_at ON certificates (tenant_id, uploaded_at DESC, id);

-- The fiscal profile of each company: one RUC, one issuer. The establishment, its address and the
-- emission point come with each sale
CREATE TABLE issuers (
  tenant_id uuid PRIMARY KEY,
  tax_id text NOT NULL,
  name text NOT NULL,
  trade_name text NOT NULL,
  main_address text NOT NULL,
  special_taxpayer_resolution text,
  withholding_agent_resolution text,
  rimpe_regime text CHECK (rimpe_regime IN ('EMPRENDEDOR', 'NEGOCIO_POPULAR')),
  accounting_required boolean NOT NULL,
  -- SRI environment of the company: 1 = pruebas, 2 = producción
  environment smallint NOT NULL CHECK (environment IN (1, 2)),
  emission_type smallint NOT NULL,
  signing_cert_id uuid,
  updated_at timestamptz NOT NULL,
  -- Only a certificate of the same company
  CONSTRAINT fk_issuers_signing_cert_tenant FOREIGN KEY (tenant_id, signing_cert_id)
    REFERENCES certificates (tenant_id, id) ON DELETE RESTRICT
);

-- Last number issued per company, establishment, emission point and document type ('01' =
-- factura). A row appears with the first document of its emission point, or when its initial value
-- is set; it never goes back
CREATE TABLE sequences (
  tenant_id uuid NOT NULL,
  establishment text NOT NULL CHECK (establishment ~ '^\d{3}$'),
  emission_point text NOT NULL CHECK (emission_point ~ '^\d{3}$'),
  doc_type text NOT NULL,
  last_value bigint NOT NULL CHECK (last_value BETWEEN 0 AND 999999999),
  PRIMARY KEY (tenant_id, establishment, emission_point, doc_type)
);

CREATE TABLE invoices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  sale_id text NOT NULL,
  -- Where the sale was made, as sales.confirmed says: the invoice's estab, ptoEmi and
  -- dirEstablecimiento. issuer_ruc is the company's RUC in faclab-core (null in a v1 message)
  issuer_ruc text,
  establishment text NOT NULL,
  emission_point text NOT NULL,
  establishment_address text,
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
  version integer NOT NULL,
  -- Each number is issued once per company, establishment and emission point (only invoices,
  -- code 01, live here); a rejected invoice keeps its number
  CONSTRAINT uq_invoices_tenant_number UNIQUE (tenant_id, establishment, emission_point, sequence)
);

-- A sale has at most one active invoice: a new one only after a rejection
CREATE UNIQUE INDEX uq_invoices_active_sale ON invoices (tenant_id, sale_id)
  WHERE status <> 'rejected';
CREATE INDEX ix_invoices_tenant_sale_id ON invoices (tenant_id, sale_id);
CREATE INDEX ix_invoices_status_created_at ON invoices (status, created_at);
CREATE INDEX ix_invoices_tenant_created_at ON invoices (tenant_id, created_at DESC, id DESC);

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

-- Back to a single issuer: the rows of every company are lost
DROP TABLE invoice_events;
DROP TABLE invoices;
DROP TABLE sequences;
DROP TABLE issuers;
DROP TABLE certificates;

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
  version integer NOT NULL
);

CREATE UNIQUE INDEX uq_invoices_active_sale ON invoices (sale_id) WHERE status <> 'rejected';
CREATE INDEX ix_invoices_sale_id ON invoices (sale_id);
CREATE INDEX ix_invoices_status_created_at ON invoices (status, created_at);
CREATE INDEX ix_invoices_created_at ON invoices (created_at DESC, id DESC);

CREATE TABLE invoice_events (
  invoice_id uuid NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  position integer NOT NULL,
  status text NOT NULL,
  occurred_at timestamptz NOT NULL,
  description text NOT NULL DEFAULT '',
  PRIMARY KEY (invoice_id, position)
);
