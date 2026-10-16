# Contratos de eventos

Forma de los mensajes que cruzan Kafka entre faclab-core y faclab-invoicing. Este directorio es la
fuente de verdad ([ADR-0006](../docs/architecture/ADR/0006-contratos-de-eventos-versionados.md)):
cada topic tiene un JSON Schema por versión y mensajes de ejemplo. El productor prueba que lo que
publica cumple el esquema; el consumidor prueba que acepta los ejemplos.

```
contracts/events/
├── sales.confirmed/
│   ├── v1.schema.json
│   └── examples/        full-customer, customer-without-contact, final-consumer, product-without-sku
└── invoices/
    ├── v1.schema.json
    └── examples/        invoice-received, invoice-authorized, invoice-rejected
```

| Topic | Productor | Consumidores | Versión vigente |
|---|---|---|---|
| `sales.confirmed` | faclab-core (`src/invoicing/infra/event_handlers.py`, vía outbox) | faclab-invoicing | 1 |
| `invoices` | faclab-invoicing (transiciones de `Invoice`) | faclab-invoicing (su máquina de estados), faclab-core (`src/invoicing/infra/invoice_messages.py`) | 1 |

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
  como texto. `event_id` e `invoiceId` son UUID en minúsculas.
- **Nulos**: solo los campos marcados como nulables aceptan `null`; ningún campo se omite.

## `sales.confirmed` v1

Venta confirmada en el admin o en el POS. Un reenvío manual (`POST /api/admin/sales/{id}/request-invoice`)
es el mismo mensaje con otro `event_id`.

| Campo | Tipo | Nulo | Notas |
|---|---|---|---|
| `event_id` | UUID | no | Nuevo en cada reenvío; faclab-invoicing deduplica por él |
| `event_type` | `"SaleConfirmed"` | no | También en los reenvíos |
| `schema_version` | `1` | no | Ver [Versiones](#versiones-y-compatibilidad) |
| `aggregate_id` | entero | no | Id de la venta |
| `occurred_at` | fecha UTC | no | Momento del evento |
| `payload.sale_id` | entero | no | |
| `payload.source` | `admin` \| `pos` | no | |
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
(decimal; lo entregado, que en efectivo puede superar el total).

## `invoices` v1

Cada transición de estado de una factura en faclab-invoicing. faclab-core solo actúa con
`InvoiceAuthorized` (la venta pasa a `INVOICED`).

| Campo | Tipo | Nulo | Notas |
|---|---|---|---|
| `schema_version` | `1` | no | |
| `type` | `InvoiceReceived` \| `InvoiceCreated` \| `InvoiceSigned` \| `InvoiceSent` \| `InvoiceAuthorized` \| `InvoiceRejected` | no | Corresponde a `status` |
| `invoiceId` | UUID | no | UUID v5 del `event_id` de `sales.confirmed` |
| `saleId` | texto con dígitos | no | `sale_id` de faclab-core |
| `status` | `pending` \| `created` \| `signed` \| `sent` \| `authorized` \| `rejected` | no | |
| `occurredAt` | fecha UTC | no | |

Este mensaje no usa todavía el envelope completo de ADR-0006 (`event_id`, `event_type`,
`payload`); adoptarlo es un cambio incompatible y llegará como v2.

## Pruebas de contrato

- **faclab-core** (`tests/contract/`, paso `Contract tests` del CI):
  - el esquema es válido y cada ejemplo lo cumple;
  - los mensajes que arma `build_sale_confirmed_message` y guarda `OutboxWriter` lo cumplen con cliente completo, sin contacto, consumidor final, cliente o productos borrados y reenvío;
  - un cambio incompatible (quitar o renombrar un campo, un monto como número, un campo sin documentar) rompe la validación;
  - `handle_invoice_message` procesa cada ejemplo de `invoices`.
  - `tests/integration/postgres/test_invoicing.py` valida además el outbox de ventas POS reales.
- **faclab-invoicing** (`test/contract/`, pasos `Contract copy matches faclab-core` y `Contract tests`):
  - cada ejemplo de `sales.confirmed` pasa por su zod y produce el XML de la factura;
  - los mensajes que publica en `invoices` cumplen `invoices/v1.schema.json`.

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

1. En faclab-core: esquema y ejemplos (o `v<n>.schema.json` nuevo), productor o consumidor, y
   `pytest tests/contract`.
2. En faclab-invoicing: `npm run contracts:sync -- <commit>`, ajustar zod y el código, `npm test`.
3. Desplegar primero a los consumidores y después al productor.
