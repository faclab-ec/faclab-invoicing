# Contratos de eventos

Forma de los mensajes que cruzan Kafka entre faclab-core y faclab-invoicing. Este directorio es la
fuente de verdad ([ADR-0006](../docs/architecture/ADR/0006-contratos-de-eventos-versionados.md)):
cada topic tiene un JSON Schema por versión y mensajes de ejemplo. El productor prueba que lo que
publica cumple el esquema; el consumidor prueba que acepta los ejemplos.

```
contracts/
├── CHANGELOG.md         qué cambió en cada versión y en qué orden se desplegó
└── events/
    ├── sales.confirmed/
    │   ├── v1.schema.json
    │   ├── v2.schema.json
    │   └── examples/
    │       ├── v1/      full-customer, customer-without-contact, final-consumer, product-without-sku
    │       └── v2/      los mismos más branch-without-address
    └── invoices/
        ├── v1.schema.json
        └── examples/
            └── v1/      invoice-received, invoice-authorized, invoice-rejected
```

| Topic | Productor | Consumidores | Versión vigente |
|---|---|---|---|
| `sales.confirmed` | faclab-core (`src/invoicing/infra/event_handlers.py`, vía outbox) | faclab-invoicing | 2 (acepta también 1, solo en desarrollo) |
| `invoices` | faclab-invoicing (transiciones de `Invoice`) | faclab-invoicing (su máquina de estados), faclab-core (`src/invoicing/infra/invoice_messages.py`) | 1 |

**Clave y headers.** Todo mensaje lleva el header `faclab-tenant-id` con la empresa y usa esa misma
empresa como clave en Kafka, así los mensajes de una empresa van en orden por la misma partición.
El core los pone desde el outbox (columna `tenant_id`) y faclab-invoicing desde la factura. El
header `traceparent` continúa la traza.

Los esquemas usan JSON Schema 2020-12 y son cerrados (`additionalProperties: false`): un campo
nuevo no se publica sin documentarlo aquí. Los consumidores, en cambio, ignoran los campos que no
conocen.

## Formatos comunes

- **Montos y porcentajes**: texto decimal, nunca número JSON. Es el `str()` de un `Decimal` de
  Python y conserva su escala: `"0"`, `"10.00"`, `"3.330000"`, `"5.99400000"`. Se leen con un
  parser decimal; los campos `invoice_*` ya vienen en centavos.
- **Fechas**: ISO 8601 en UTC con sufijo `Z`. `sales.confirmed` puede traer microsegundos
  (`2026-10-15T15:04:05.123456Z`); `invoices` trae milisegundos (`Date.toISOString()`).
- **Ids**: los de faclab-core son enteros (`sale_id`, `product_id`); en `invoices`, `saleId` va
  como texto. `event_id`, `tenant_id` e `invoiceId` son UUID en minúsculas.
- **Códigos SRI**: el establecimiento y el punto de emisión son texto de tres dígitos, de `001` a
  `999`.
- **Nulos**: solo los campos marcados como nulables aceptan `null`; ningún campo se omite.

## `sales.confirmed` v2

Venta confirmada en el POS (o una anterior reenviada desde el admin). Un reenvío manual
(`POST /api/admin/sales/{id}/request-invoice`) es el mismo mensaje con otro `event_id`. Dice quién
emite y desde dónde: faclab-invoicing usa el perfil fiscal, el certificado y el secuencial de esa
empresa, establecimiento y punto de emisión. Una venta sin punto de emisión (anterior a S2.6) no se
publica: el core responde `SALE_WITHOUT_EMISSION_POINT`.

| Campo | Tipo | Nulo | Notas |
|---|---|---|---|
| `event_id` | UUID | no | Nuevo en cada reenvío; faclab-invoicing deduplica por él |
| `event_type` | `"SaleConfirmed"` | no | También en los reenvíos |
| `schema_version` | `2` | no | Ver [Versiones](#versiones-y-compatibilidad) |
| `tenant_id` | UUID | no | Empresa que emite; igual al header `faclab-tenant-id` y a la clave del mensaje |
| `aggregate_id` | entero | no | Id de la venta |
| `occurred_at` | fecha UTC | no | Momento del evento |
| `payload.sale_id` | entero | no | |
| `payload.sale_number` | texto | **sí** | Número de la venta en su sucursal (`V-001-000123`); `null` en ventas sin número. No es el secuencial de la factura |
| `payload.source` | `admin` \| `pos` | no | `admin` solo en reenvíos de ventas sin turno |
| `payload.issuer_ruc` | 13 dígitos | no | RUC de la empresa; faclab-invoicing no emite si no coincide con su perfil fiscal |
| `payload.establishment_code` | código SRI | no | Establecimiento de la sucursal de la venta (`estab`) |
| `payload.establishment_address` | texto | **sí** | Dirección de la sucursal (`dirEstablecimiento`); `null` si no la tiene y la factura sale sin ese campo |
| `payload.emission_point_code` | código SRI | no | Punto de emisión de la venta (`ptoEmi`), el de su terminal |
| `payload.subtotal` | decimal | no | Suma de subtotales de los ítems, antes del descuento global |
| `payload.total_discount` | decimal | no | Descuento global (monto) |
| `payload.total` | decimal | no | Total cobrado = Σ `invoice_base` + Σ `invoice_tax` |
| `payload.customer` | objeto | **sí** | `null`: consumidor final, o el cliente ya no existe |
| `payload.items` | lista (≥ 1) | no | |
| `payload.payments` | lista | no | |

`customer`:

| Campo | Tipo | Nulo | Notas |
|---|---|---|---|
| `id` | entero | no | |
| `name` | texto | no | |
| `tax_id` | texto | no | RUC, cédula, pasaporte o identificación del exterior |
| `tax_type` | `RUC` \| `NATIONAL_ID` \| `PASSPORT` \| `FOREIGN_ID` | no | |
| `email`, `phone`, `address` | texto | **sí** | El cliente puede no tenerlos; el SRI no los exige |

`items[]`:

| Campo | Tipo | Nulo | Notas |
|---|---|---|---|
| `product_id` | entero | no | |
| `sku` | texto | **sí** | `null` si el producto no tiene SKU o ya no existe |
| `product_name` | texto | **sí** | `null` si el producto ya no existe |
| `quantity` | entero | no | |
| `unit_price` | decimal | no | Precio unitario sin IVA, a precisión completa |
| `discount` | decimal | no | Descuento de la línea en porcentaje (0-100) |
| `tax_code` | `VAT_0` \| `VAT_5` \| `VAT_8_TOURISM` \| `VAT_12` \| `VAT_13` \| `VAT_14` \| `VAT_15` \| `EXEMPT` \| `NOT_TAXED` | no | Código semántico de IVA (`TaxCode`) |
| `tax_amount` | decimal | no | IVA de la línea a precisión completa, antes del descuento global |
| `subtotal` | decimal | no | Cantidad × precio menos el descuento de la línea |
| `invoice_discount` | decimal | no | Descuento de la línea en la factura (propio + su parte del global), en centavos |
| `invoice_base` | decimal | no | `precioTotalSinImpuesto` y `baseImponible`, en centavos |
| `invoice_tax` | decimal | no | Valor del IVA en la factura, en centavos |

`payments[]`: `method` (`CASH` \| `CREDIT_CARD` \| `DEBIT_CARD` \| `TRANSFER` \| `OTHER`) y `amount`
(decimal; lo aplicado a la venta, sin el vuelto). La suma de `payments[].amount` es igual a `total`
desde S3.3: el core guarda aparte lo entregado y el vuelto, que no viajan a facturación.

### `sales.confirmed` v1

Es v2 sin `tenant_id` ni los campos `sale_number`, `issuer_ruc`, `establishment_code`,
`establishment_address` y `emission_point_code`. faclab-invoicing la acepta solo en desarrollo y
con un emisor por defecto (`SALES_V1_TENANT_ID`), con establecimiento y punto de emisión `001`. En
producción va a la cola de mensajes fallidos.

## `invoices` v1

Cada transición de estado de una factura en faclab-invoicing. faclab-core solo actúa con
`InvoiceAuthorized` (la venta pasa a `INVOICED` y su factura a `AUTHORIZED`) e `InvoiceRejected`
(la factura pasa a `REJECTED`, con el motivo).

| Campo | Tipo | Nulo | Notas |
|---|---|---|---|
| `schema_version` | `1` | no | |
| `type` | `InvoiceReceived` \| `InvoiceCreated` \| `InvoiceSigned` \| `InvoiceSent` \| `InvoiceAuthorized` \| `InvoiceRejected` | no | Corresponde a `status` |
| `invoiceId` | UUID | no | UUID v5 del `event_id` de `sales.confirmed` |
| `saleId` | texto con dígitos | no | `sale_id` de faclab-core |
| `status` | `pending` \| `created` \| `signed` \| `sent` \| `authorized` \| `rejected` | no | |
| `occurredAt` | fecha UTC | no | |
| `reason` | texto | **sí** | Solo en `InvoiceRejected`: los mensajes del SRI unidos con `' >> '` (`null` si no trajo ninguno). Opcional: falta en los mensajes anteriores a S3.4. El core lo muestra en la venta (`invoiceRejectionReason`) |

Este mensaje no usa todavía el envelope completo de ADR-0006 (`event_id`, `event_type`,
`payload`); adoptarlo es un cambio incompatible y llegará como v2. La empresa no va en el cuerpo
(el esquema es cerrado) sino en el header `faclab-tenant-id`, con el que el core abre el contexto;
un mensaje sin él se descarta.

## Pruebas de contrato

- **faclab-core** (`tests/contract/`, paso `Contract tests` del CI):
  - el esquema es válido y cada ejemplo lo cumple (los de v1 cumplen v1 mientras facturación la acepte);
  - los mensajes que arma `build_sale_confirmed_message` y guarda `OutboxWriter` cumplen v2 con cliente completo, sin contacto, consumidor final, cliente o productos borrados, reenvío, venta sin número y sucursal sin dirección;
  - un cambio incompatible (quitar o renombrar un campo, un monto como número, un campo sin documentar) rompe la validación;
  - `handle_invoice_message` procesa cada ejemplo de `invoices` (el rechazo, con su `reason`), y
    `reason` es opcional.
  - `tests/integration/postgres/test_invoicing.py` valida además el outbox de ventas POS reales.
- **faclab-invoicing** (`test/contract/`, pasos `Contract copy matches faclab-core` y `Contract tests`):
  - cada ejemplo de `sales.confirmed` (v1 y v2) pasa por su zod y produce el XML de la factura; con
    v2, el XML usa el establecimiento, la dirección y el punto de emisión del mensaje;
  - los mensajes que publica en `invoices` cumplen `invoices/v1.schema.json`, y el rechazo lleva
    los mensajes del SRI en `reason`.

## Cómo lo obtiene faclab-invoicing

faclab-invoicing guarda una copia de este directorio en su propio `contracts/`, con
`contracts/source.json` (repositorio y commit de faclab-core del que salió). Así sus pruebas no
dependen de la red ni de un clon del core, y el diff de su PR muestra qué cambió en el contrato.

```bash
# en faclab-invoicing: copia contracts/ de faclab-core en ese commit, rama o tag
npm run contracts:sync -- <ref>
# antes de publicar la rama del core, desde el clon local
CORE_REPO=../faclab-core npm run contracts:sync -- <rama>
```

El CI de invoicing hace checkout de faclab-core en el commit de `source.json` y compara con
`diff -r`: la copia no se edita a mano. Tras el squash-merge del PR del core, se vuelve a
sincronizar con el commit de `master` antes de integrar el PR de invoicing.

## Versiones y compatibilidad

- **Sin cambio de versión** (se actualizan esquema y ejemplos en la misma versión):
  - agregar un campo nuevo que los consumidores pueden ignorar;
  - agregar un valor a un enum o volver nulable un campo. El consumidor que lo valida tiene que
    aceptarlo antes: se despliega primero (fue el caso de G-08).
- **Nueva versión** (`schema_version` + 1, archivo `v<n>.schema.json` nuevo; la anterior se
  conserva mientras haya mensajes suyos en circulación):
  - renombrar o quitar un campo, cambiar su tipo o formato, volver obligatorio un campo nuevo o
    cambiar su significado.
- **Orden**: el productor publica una versión nueva solo cuando todos sus consumidores aceptan la
  anterior y la nueva. Cada PR que toque un contrato dice en qué orden se despliega.
- **Mensajes sin `schema_version`** (anteriores a v1, todavía en el outbox o en el topic): se tratan
  como v1.
- **Versión desconocida**: faclab-invoicing la rechaza al validar y el mensaje va a su cola de
  mensajes fallidos (DLQ); faclab-core la registra (`invoice_message_unsupported_version`) y la
  descarta.

### Cambiar un contrato

1. En faclab-core: esquema y ejemplos (o `v<n>.schema.json` nuevo y `examples/v<n>/`), productor o
   consumidor, `CHANGELOG.md` y `pytest tests/contract`.
2. En faclab-invoicing: `npm run contracts:sync -- <commit>`, ajustar zod y el código, `npm test`.
3. Desplegar primero a los consumidores y después al productor.
