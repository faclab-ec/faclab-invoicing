# XSD of the electronic documents

`XsdInvoiceSchemaValidator` checks every document's XML against the schema of its type before it is
signed. The image copies this folder (`Dockerfile`).

| File | Source | SHA-256 of the original |
|---|---|---|
| `factura_V1.1.0.xsd` | SRI, "XML y XSD Factura.zip" (versions 1.0.0, 1.1.0, 2.0.0 and 2.1.0, updated February 2022), linked from https://www.sri.gob.ec/facturacion-electronica | `62db9bf0ecceb00ef2b7ed136e59224815e5e5e33c77efc6a0552001e052eb8b` (zip: `ba1ff0c4e329fe759c3f88dc75f2975780b315b6eb3d0069071b77c1f26fec03`) |
| `notaCredito_V1.1.0.xsd` | SRI, "XML y XSD Nota de Crédito.zip" (versions 1.0.0 and 1.1.0, updated February 2022), linked from https://www.sri.gob.ec/facturacion-electronica | `379e9f270d71ab4578f130a736c9abe5eb1d7969375ecdef55d2973583ec5ab0` (zip: `9b7e9c1a240ae39a858aa8fbaf91c41c761417e7bd763ccb20ffc0b81ad1bd43`) |
| `xmldsig-core-schema.xsd` | W3C, https://www.w3.org/TR/xmldsig-core/xmldsig-core-schema.xsd (imported by the SRI schema) | `d102ad3df7664c307e0c2c776ba4a90513b1969974d8a940bae1a77f9f21e15d` |

The invoice's was downloaded on 2026-10-29 and the credit note's on 2026-11-02. The ficha técnica in
force then was the offline scheme's version 2.34 (27/07/2026).

## Local change

`contribuyenteRimpe` in the published XSD only allows `CONTRIBUYENTE RÉGIMEN RIMPE`. The ficha
técnica (Anexo 22, since version 2.22 of September 2022) also requires `CONTRIBUYENTE NEGOCIO POPULAR -
RÉGIMEN RIMPE` for Negocio Popular taxpayers in the same tag, so the second pattern was added (marked
with a `faclab:` comment) to both schemas. It is the only difference with the original files.

## Version

Invoices stay on version **1.1.0**. 2.0.0 and 2.1.0 only add the invoice that replaces a remission
guide (`infoSustitutivaGuiaRemision`) and third-party items (`otrosRubrosTerceros`), which Faclab
doesn't issue. 1.1.0 already takes six decimals in `cantidad` and `precioUnitario`. Credit notes use
**1.1.0** too, for the same reason: it is 1.0.0 with those six decimals.

To update: download the zip again, replace the file, apply the change above if it is still missing
and update the table.
