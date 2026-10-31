-- Up Migration

-- S4.4: the issuer's email, the Reply-To of the emails that carry its invoices to the buyer, and its
-- logo, drawn on the RIDE. The logo itself is in the object storage, under
-- tenants/{tenant_id}/issuer/logo; the row keeps where and its type
ALTER TABLE issuers
  ADD COLUMN email text,
  ADD COLUMN logo_key text,
  ADD COLUMN logo_content_type text CHECK (logo_content_type IN ('image/png', 'image/jpeg')),
  ADD CONSTRAINT ck_issuers_logo CHECK ((logo_key IS NULL) = (logo_content_type IS NULL));

-- Down Migration

ALTER TABLE issuers
  DROP CONSTRAINT ck_issuers_logo,
  DROP COLUMN logo_content_type,
  DROP COLUMN logo_key,
  DROP COLUMN email;
