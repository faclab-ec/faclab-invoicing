# Cambios en los contratos

Cada versión de un mensaje, qué cambió y en qué orden se desplegó. Las reglas de compatibilidad
están en [README.md](README.md#versiones-y-compatibilidad).

## `sales.confirmed` v2 (S2.8, 2026-10)

- **Nuevos**: `tenant_id` en el sobre y, en `payload`, `sale_number`, `issuer_ruc`,
  `establishment_code`, `establishment_address` y `emission_point_code`. Con ellos faclab-invoicing
  factura con el perfil fiscal, el certificado y el secuencial de la empresa, el establecimiento y
  el punto de emisión de la venta.
- **Incompatible**: los campos nuevos son obligatorios (las direcciones y el número pueden ser
  `null`), así que es una versión nueva.
- **Kafka**: el core usa la empresa como clave del mensaje (también en los demás topics que publica)
  y sigue enviando el header `faclab-tenant-id`.
- **Despliegue**: primero faclab-invoicing (acepta v1 y v2), después faclab-core (publica v2).
- **Vuelta atrás**: el core puede volver a publicar v1; faclab-invoicing la acepta solo en
  desarrollo, con `SALES_V1_TENANT_ID`. En producción hay que revertir ambos.

## `invoices` v1 (S2.8, 2026-10)

- Sin cambios en el cuerpo. faclab-invoicing agrega el header `faclab-tenant-id` y usa la empresa
  como clave. El core deja de buscar la empresa por el id de la venta: un mensaje sin el header se
  descarta.
- **Despliegue**: primero faclab-invoicing, después faclab-core.

## `sales.confirmed` v1 e `invoices` v1 (S1.6, 2026-10-15)

- Primera versión con `schema_version` de ambos mensajes, sus esquemas y sus ejemplos.
- `sales.confirmed`: el cliente sin email, teléfono ni dirección viaja con `null` (G-08), y los
  ítems llevan los montos de la factura (`invoice_discount`, `invoice_base`, `invoice_tax`).
