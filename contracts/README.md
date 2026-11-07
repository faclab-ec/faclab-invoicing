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
    │       └── v2/      los mismos más branch-without-address y construction-material
    ├── invoices/
    │   ├── v1.schema.json
    │   └── examples/
    │       └── v1/      invoice-received, invoice-authorized, invoice-rejected
    ├── credit_notes.requested/
    │   ├── v1.schema.json
    │   └── examples/
    │       └── v1/      refund, cancelled-sale, branch-without-address, construction-material
    └── credit_notes.results/
        ├── v1.schema.json
        └── examples/
            └── v1/      credit-note-authorized, credit-note-rejected, rejected-without-number
```

| Topic | Productor | Consumidores | Versión vigente |
|---|---|---|---|
| `sales.confirmed` | faclab-core (`src/invoicing/infra/event_handlers.py`, vía outbox) | faclab-invoicing | 2 (acepta también 1, solo en desarrollo) |
| `invoices` | faclab-invoicing (resultado de cada `Invoice`, desde su worker) | faclab-core (`src/invoicing/infra/invoice_messages.py`) | 1 |
| `credit_notes.requested` | faclab-core (`src/invoicing/infra/event_handlers.py`, vía outbox) | faclab-invoicing | 1 |
| `credit_notes.results` | faclab-invoicing (resultado de cada nota, desde su worker) | faclab-core (`src/invoicing/infra/credit_note_messages.py`) | 1 |

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
  `999`. `construction_material_code` es un código de la Tabla 31 del Anexo 23 de la ficha técnica
  (`F010401`, cemento).
- **Nulos**: solo los campos marcados como nulables aceptan `null`; ningún campo se omite, salvo
  `construction_material_code`, que falta en los mensajes anteriores a S4.6 (el core siempre lo envía
  desde entonces).

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
| `construction_material_code` | código de la Tabla 31 | **sí** | Subcategoría del material de construcción (Anexo 23 de la ficha técnica, Res. NAC-DGERCGC24-00000013); va en `codigoAuxiliar` en lugar del SKU. `null` si el producto no es uno de esos materiales o ya no existe. Opcional: falta en los mensajes anteriores a S4.6 |
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

El resultado de una factura en faclab-invoicing: `InvoiceAuthorized` (la venta pasa a `INVOICED` y
su factura a `AUTHORIZED`) o `InvoiceRejected` (la factura pasa a `REJECTED`, con el motivo).
Hasta S4.2 faclab-invoicing publicaba aquí cada transición y las consumía como su máquina de
estados; desde S4.2 avanza las facturas con una cola en su base y solo publica estos dos tipos. v1
sigue admitiendo los otros cuatro (`InvoiceReceived`, `InvoiceCreated`, `InvoiceSigned`,
`InvoiceSent`), que el core ignora y nadie publica ya. Un mismo resultado puede llegar más de una
vez (la publicación se reintenta si Kafka falla): el core lo aplica una sola vez.

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

## `credit_notes.requested` v1

faclab-core pide una nota de crédito (codDoc 04) por una devolución de una venta facturada o por la
factura autorizada de una venta anulada. Usa el envelope completo de ADR-0006. Dice qué se acredita y
desde dónde; el comprador, el número y la fecha de la factura los toma faclab-invoicing de su propio
documento (`invoice_id`), que es la fuente correcta. Volver a pedirla
(`POST /api/admin/credit-notes/{id}/request-again`) es el mismo mensaje con otro `event_id`.

| Campo | Tipo | Nulo | Notas |
|---|---|---|---|
| `event_id` | UUID | no | Nuevo cada vez que se vuelve a pedir; faclab-invoicing deduplica por él |
| `event_type` | `"CreditNoteRequested"` | no | |
| `schema_version` | `1` | no | |
| `tenant_id` | UUID | no | Empresa que emite; igual al header `faclab-tenant-id` y a la clave del mensaje |
| `aggregate_id` | entero | no | Id de la nota en faclab-core |
| `occurred_at` | fecha UTC | no | Cuándo se pidió. Con `INVOICE_EMISSION_DATE=sale` es su fecha de emisión |
| `payload.credit_note_id` | entero | no | Un documento activo por cada uno en faclab-invoicing |
| `payload.sale_id` | entero | no | |
| `payload.invoice_id` | UUID | no | La factura autorizada que modifica (`invoiceId` de `invoices`) |
| `payload.refund_id` | entero | **sí** | `null`: acredita la factura de una venta anulada |
| `payload.refund_number` | texto | **sí** | Número interno de la devolución (`D-001-000045`). No es el secuencial de la nota |
| `payload.issuer_ruc` | 13 dígitos | no | faclab-invoicing no emite si no coincide con su perfil fiscal |
| `payload.establishment_code` | código SRI | no | `estab` |
| `payload.establishment_address` | texto | **sí** | `dirEstablecimiento` |
| `payload.emission_point_code` | código SRI | no | `ptoEmi`: el de la terminal de la devolución o, si no hay, el de la venta |
| `payload.reason` | texto (≥ 1) | no | `motivo`, obligatorio en el XML |
| `payload.subtotal` | decimal | no | Σ `invoice_base` (`totalSinImpuestos`) |
| `payload.tax` | decimal | no | Σ `invoice_tax` |
| `payload.total` | decimal | no | `subtotal + tax` (`valorModificacion`) |
| `payload.items` | lista (≥ 1) | no | |

`items[]`: `product_id`, `sku`, `construction_material_code` y `product_name` (nulables, como en
`sales.confirmed`; el código va en `codigoAdicional` en lugar del SKU y es opcional), `quantity`,
`unit_price`, `tax_code` (el de la venta: la tarifa es la de la fecha del documento de sustento, ficha
2.34) e `invoice_discount`, `invoice_base` e `invoice_tax`, en centavos.

## `credit_notes.results` v1

El resultado de cada nota. `CreditNoteAuthorized` deja la nota `AUTHORIZED` en el core y, si la venta
quedó acreditada por completo, su factura en `CREDITED`. `CreditNoteRejected` deja la nota `REJECTED`
con el motivo, y se puede volver a pedir. No se publica en `invoices` porque el core marcaría la venta
como facturada. Un resultado puede repetirse: el core lo aplica una sola vez.

| Campo | Tipo | Nulo | Notas |
|---|---|---|---|
| `event_id` | UUID | no | El mismo si el resultado se vuelve a publicar |
| `event_type` | `CreditNoteAuthorized` \| `CreditNoteRejected` | no | |
| `schema_version` | `1` | no | |
| `tenant_id` | UUID | no | |
| `aggregate_id` | entero | no | Id de la nota en faclab-core |
| `occurred_at` | fecha UTC | no | |
| `payload.credit_note_id` | entero | no | |
| `payload.document_id` | UUID | no | Documento en faclab-invoicing: con él se descargan su XML y su RIDE |
| `payload.sale_id` | entero | no | |
| `payload.number` | `001-001-000000012` | **sí** | `null` si se rechazó antes de numerarla; obligatorio al autorizar |
| `payload.access_code` | 49 dígitos | **sí** | `null` si se rechazó antes de armar el XML; obligatorio al autorizar |
| `payload.authorized_at` | fecha UTC | **sí** | Obligatorio al autorizar |
| `payload.reason` | texto | **sí** | Por qué se rechazó |

## Pruebas de contrato

- **faclab-core** (`tests/contract/`, paso `Contract tests` del CI):
  - el esquema es válido y cada ejemplo lo cumple (los de v1 cumplen v1 mientras facturación la acepte);
  - los mensajes que arma `build_sale_confirmed_message` y guarda `OutboxWriter` cumplen v2 con cliente completo, sin contacto, consumidor final, cliente o productos borrados, reenvío, venta sin número y sucursal sin dirección;
  - un cambio incompatible (quitar o renombrar un campo, un monto como número, un campo sin documentar) rompe la validación;
  - `handle_invoice_message` procesa cada ejemplo de `invoices` (el rechazo, con su `reason`), y
    `reason` es opcional.
  - `tests/integration/postgres/test_invoicing.py` valida además el outbox de ventas POS reales;
  - los mensajes de `credit_notes.requested` que arma y guarda el outbox cumplen v1
    (`test_credit_notes.py`), y `handle_credit_note_message` aplica cada ejemplo de
    `credit_notes.results`.
- **faclab-invoicing** (`test/contract/`, pasos `Contract copy matches faclab-core` y `Contract tests`):
  - cada ejemplo de `sales.confirmed` (v1 y v2) pasa por su zod y produce el XML de la factura; con
    v2, el XML usa el establecimiento, la dirección y el punto de emisión del mensaje;
  - los mensajes que publica en `invoices` (solo `InvoiceAuthorized` e `InvoiceRejected`) cumplen
    `invoices/v1.schema.json`, y el rechazo lleva los mensajes del SRI en `reason`;
  - cada ejemplo de `credit_notes.requested` pasa por su zod y produce el XML de la nota contra el
    XSD real, y lo que publica en `credit_notes.results` cumple su esquema.

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
- **Versión desconocida**: faclab-invoicing la rechaza al validar y el mensaje queda en su tabla de
  mensajes fallidos (`dead_letters`, S4.3); faclab-core la registra (`invoice_message_unsupported_version`) y la
  descarta.

### Cambiar un contrato

1. En faclab-core: esquema y ejemplos (o `v<n>.schema.json` nuevo y `examples/v<n>/`), productor o
   consumidor, `CHANGELOG.md` y `pytest tests/contract`.
2. En faclab-invoicing: `npm run contracts:sync -- <commit>`, ajustar zod y el código, `npm test`.
3. Desplegar primero a los consumidores y después al productor.
