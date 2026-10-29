-- Up Migration

-- S4.1: when faclab-core asked to invoice the sale (the emission date with
-- INVOICE_EMISSION_DATE=sale), the random numeric code of the access code, and what the SRI
-- authorized with the key of the authorized XML in the object storage
ALTER TABLE invoices
  ADD COLUMN requested_at timestamptz,
  ADD COLUMN numeric_code text CHECK (numeric_code ~ '^\d{8}$'),
  ADD COLUMN authorization_number text,
  ADD COLUMN authorized_at timestamptz,
  ADD COLUMN authorized_xml_key text;

-- Invoices numbered before: their access code has the numeric code (digits 40 to 47); without one
-- yet, a new random code
UPDATE invoices SET numeric_code = substring(access_code FROM 40 FOR 8)
  WHERE access_code IS NOT NULL;
UPDATE invoices SET numeric_code = lpad(floor(random() * 100000000)::bigint::text, 8, '0')
  WHERE numeric_code IS NULL AND sequence IS NOT NULL;

-- The numeric code is assigned with the number
ALTER TABLE invoices ADD CONSTRAINT ck_invoices_numbered_numeric_code
  CHECK (sequence IS NULL OR numeric_code IS NOT NULL);

-- Down Migration

ALTER TABLE invoices DROP CONSTRAINT ck_invoices_numbered_numeric_code;
ALTER TABLE invoices
  DROP COLUMN authorized_xml_key,
  DROP COLUMN authorized_at,
  DROP COLUMN authorization_number,
  DROP COLUMN numeric_code,
  DROP COLUMN requested_at;
