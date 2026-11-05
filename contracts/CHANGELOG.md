# Cambios en los contratos

Cada versión de un mensaje, qué cambió y en qué orden se desplegó. Las reglas de compatibilidad
están en [README.md](README.md#versiones-y-compatibilidad).

## `sales.confirmed` v2 y `credit_notes.requested` v1: código de material de construcción (S4.6, 2026-11)

- **Campo nuevo y compatible**, sin cambio de versión: `construction_material_code` en cada línea,
  nulable y opcional. Es la subcategoría de la Tabla 31 del Anexo 23 de la ficha técnica 2.34 (Res.
  NAC-DGERCGC24-00000013). faclab-invoicing la escribe en `codigoAuxiliar` de la factura y en
  `codigoAdicional` de la nota de crédito, en lugar del SKU. Un mensaje sin el campo se factura igual,
  con el SKU.
- **Despliegue**: faclab-invoicing (acepta el campo y lo usa), faclab-core (lo envía), faclab-web.
- **Vuelta atrás**: revertir; las líneas vuelven al SKU.

## `credit_notes.requested` v1 y `credit_notes.results` v1 (S4.5, 2026-11)

- **Nuevos**, con el envelope completo de ADR-0006. El core pide una nota de crédito (codDoc 04) por
  una devolución de una venta facturada o por la factura autorizada de una venta anulada, y
  faclab-invoicing responde con su resultado en un topic propio: en `invoices` marcaría la venta como
  facturada.
- **Kafka**: dos topics nuevos, que crea `faclab-infra/scripts/create-topics.sh` (la autocreación está
  apagada).
- **Despliegue**: faclab-infra (topics), faclab-invoicing (consume y publica), faclab-core (consume y
  publica), faclab-web.
- **Vuelta atrás**: `CREDIT_NOTES_ENABLED=false` en el core deja de pedir notas; las emitidas se
  conservan.

## `invoices` v1: solo el resultado de cada factura (S4.2, 2026-10)

- **Sin cambio de esquema**: faclab-invoicing deja de consumir `invoices` (avanza sus facturas con
  una cola en PostgreSQL) y solo publica `InvoiceAuthorized` e `InvoiceRejected`, desde su worker.
  Los otros cuatro tipos siguen siendo válidos en v1, pero ya no se publican.
- Un resultado puede repetirse: si Kafka falla, faclab-invoicing vuelve a publicarlo. El core ya
  ignoraba la repetición (una venta facturada no cambia; un rechazo repetido tampoco).
- **Despliegue**: solo faclab-invoicing; el core no cambia.

## `invoices` v1: motivo del rechazo (S3.4, 2026-10)

- **Nuevo, opcional**: `reason` (texto o `null`) en `InvoiceRejected`, con los mensajes del SRI
  unidos con `' >> '`. El core lo guarda en la venta (`invoice_rejection_reason`) y lo muestra en
  sus respuestas (`invoiceRejectionReason`).
- **Compatible, sin cambio de versión**: es un campo nuevo que los consumidores pueden ignorar, y no
  es obligatorio, así que los mensajes anteriores siguen cumpliendo v1.
- **Despliegue**: primero faclab-core (lee `reason` si viene), después faclab-invoicing (lo
  publica). Su propio consumidor de `invoices` lo acepta en el mismo despliegue.

## `sales.confirmed` v2: pagos aplicados (S3.3, 2026-10)

- **Sin cambio de forma ni de versión**: `payments[].amount` pasa a ser lo aplicado a la venta, sin el
  vuelto, así que la suma de los pagos es igual a `total` (antes era lo entregado y en efectivo podía
  superarlo, G-16). El core guarda aparte lo entregado y el vuelto; no viajan en el mensaje.
- **Compatible**: todo mensaje nuevo también cumplía el significado anterior (lo entregado puede ser
  igual al total), y faclab-invoicing ya escribía `amount` como el `total` de cada forma de pago del
  XML. No hay orden de despliegue.
- Los ejemplos `final-consumer` y `branch-without-address` de v2 pagan lo aplicado (`7.44`). Los de
  v1 quedan como estaban.

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
