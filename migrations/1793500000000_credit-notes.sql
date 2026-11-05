-- Up Migration

-- S4.5: `invoices` holds every electronic document Faclab issues: `doc_type` is its SRI code (01
-- invoice, 04 credit note). A credit note goes through the same steps, queue and worker; what it
-- credits is in `credit_note`, the id faclab-core gave it in `request_id` and the invoice it
-- modifies in `source_invoice_id` (null when the invoice it names doesn't exist: it ends rejected)
ALTER TABLE invoices
  ADD COLUMN doc_type text NOT NULL DEFAULT '01' CHECK (doc_type IN ('01', '04')),
  ADD COLUMN source_invoice_id uuid REFERENCES invoices (id),
  ADD COLUMN credit_note jsonb,
  ADD COLUMN request_id integer;

-- Each type has its own numbering per emission point (sequences.doc_type)
ALTER TABLE invoices DROP CONSTRAINT uq_invoices_tenant_number;
ALTER TABLE invoices ADD CONSTRAINT uq_invoices_tenant_number
  UNIQUE (tenant_id, establishment, emission_point, doc_type, sequence);

-- A sale has at most one active invoice, and any number of credit notes
DROP INDEX uq_invoices_active_sale;
CREATE UNIQUE INDEX uq_invoices_active_sale ON invoices (tenant_id, sale_id)
  WHERE status <> 'rejected' AND doc_type = '01';

-- A credit note of faclab-core has at most one active document: another only after a rejection
CREATE UNIQUE INDEX uq_invoices_active_credit_note ON invoices (tenant_id, request_id)
  WHERE status <> 'rejected' AND doc_type = '04';
CREATE INDEX ix_invoices_tenant_doc_type_created_at
  ON invoices (tenant_id, doc_type, created_at DESC, id DESC);

-- Down Migration

DELETE FROM invoices WHERE doc_type <> '01';
DELETE FROM sequences WHERE doc_type <> '01';
DROP INDEX ix_invoices_tenant_doc_type_created_at;
DROP INDEX uq_invoices_active_credit_note;
DROP INDEX uq_invoices_active_sale;
CREATE UNIQUE INDEX uq_invoices_active_sale ON invoices (tenant_id, sale_id)
  WHERE status <> 'rejected';
ALTER TABLE invoices DROP CONSTRAINT uq_invoices_tenant_number;
ALTER TABLE invoices ADD CONSTRAINT uq_invoices_tenant_number
  UNIQUE (tenant_id, establishment, emission_point, sequence);
ALTER TABLE invoices
  DROP COLUMN request_id,
  DROP COLUMN credit_note,
  DROP COLUMN source_invoice_id,
  DROP COLUMN doc_type;
