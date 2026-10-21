# Faclab Invoicing — Electronic Invoice Service

Event-driven microservice that integrates with Ecuador's **SRI** (Servicio de Rentas Internas) tax authority. It listens to sale confirmation events from Kafka, generates compliant electronic invoice XML, signs it with XAdES-BES, submits it to SRI SOAP endpoints for validation and authorization, and persists the full invoice lifecycle in PostgreSQL.

It is **multi-company**: each company (a faclab-core tenant, one RUC) has its own fiscal profile, certificates, SRI environment and sequences per establishment and emission point. A sale says which company issues it and from where (`sales.confirmed` v2), and the HTTP API only shows the company of the caller's token (`tid`).

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Invoice Lifecycle](#invoice-lifecycle)
- [Modules](#modules)
- [HTTP API](#http-api)
- [API Response Format](#api-response-format)
- [Kafka Topics](#kafka-topics)
- [Persistence](#persistence)
- [Configuration](#configuration)
- [Observability](#observability)
- [Local Development](#local-development)
- [Docker](#docker)
- [Project Structure](#project-structure)

---

## Architecture Overview

Clean Architecture with CQRS and domain events. Dependencies flow inward: infrastructure → application → domain.

```
┌─────────────────────────────────────────────────────┐
│                    Infrastructure                    │
│     Kafka  │  PostgreSQL  │  SRI SOAP  │  HTTP      │
├─────────────────────────────────────────────────────┤
│                    Application                      │
│      Commands  │  Queries  │  Event Handlers         │
├─────────────────────────────────────────────────────┤
│                      Domain                         │
│   Entities  │  Value Objects  │  Ports  │  Events    │
└─────────────────────────────────────────────────────┘
```

**Key patterns:**
- **Ports & Adapters:** Domain defines interfaces (ports); infrastructure provides implementations.
- **Manual DI:** All wiring done in `src/container.ts` — no framework.
- **Zod validation:** All external inputs (Kafka messages, HTTP bodies) validated at the boundary.
- **Self-messaging:** The `invoices` Kafka topic drives the invoice state machine by re-publishing domain events after each state transition.

---

## Invoice Lifecycle

Triggered by a `SaleConfirmed` event on the `sales.confirmed` Kafka topic:

```
sales.confirmed ──► ReceiveSale ──► PENDING
                                         │
                    ◄────── invoices ◄───┘
                      PrepareInvoice ──► CREATED   (waits while the issuer isn't ready)
                                         │
                    ◄────── invoices ◄───┘
                         SignInvoice ──► SIGNED
                                         │
                    ◄────── invoices ◄───┘
                         SendInvoice ──► SENT (or REJECTED)
                                         │
                    ◄────── invoices ◄───┘
                      AuthorizeInvoice ──► AUTHORIZED (or REJECTED)
```

Each transition is an isolated Command. `InvoiceEventHandler` reads from the `invoices` topic and dispatches to the right command based on the invoice's current status.

### Nothing is lost: pending invoices, issues and recovery

- **The sale is stored first.** `ReceiveSale` saves a `pending` invoice of its company, with the sale data and where it was made (establishment, its address and emission point), before looking at the config, so a sale confirmed while the fiscal config or the certificate are missing waits instead of failing. `PrepareInvoice` assigns the sequence (once) and builds the XML when the company's issuer is ready. The emission date is the day the XML is built.
- **Idempotent.** The invoice id is a UUID v5 of the message's `event_id`: the same message twice creates one invoice. A resend from faclab-core (new `event_id`) is ignored while the sale has an invoice that isn't `rejected`; the partial unique index `uq_invoices_active_sale` (company and sale) keeps that true when two resends arrive at the same time. Updates check a `version` column (optimistic locking).
- **A failed step is recorded, not thrown.** The invoice keeps its status and gets an `issue` (`code`, `message`, `at`), `attempts` and `nextAttemptAt`; the next transition clears it. The `dlq` topic is left for malformed messages and storage outages.
  - Issuer problems (`CONFIG_MISSING`, `CONFIG_INVALID`, `ENVIRONMENT_NOT_ALLOWED`, `CERTIFICATE_NOT_SELECTED`, `CERTIFICATE_NOT_FOUND`, `CERTIFICATE_EXPIRED`, `CERTIFICATE_UNREADABLE`, `CERTIFICATE_RUC_MISMATCH`) wait until the company's issuer is ready.
  - `ISSUER_RUC_MISMATCH`: the sale names a RUC other than the company's profile. The invoice waits until the profile has that RUC.
  - `SRI_UNAVAILABLE` (SOAP error or timeout), `SRI_PROCESSING` (no authorization yet, or `EN PROCESO`) and `UNEXPECTED_ERROR` are retried after 1, 5, 15 and then every 60 minutes, up to 10 attempts; after that only by hand.
  - A reception `DEVUELTA` whose only messages are 43 (access code already registered) or 70 (access code being processed) means the SRI already has the voucher: the invoice moves on to authorization.
- **Recovery** (`InvoiceRecoveryService`) runs at start, every `INVOICE_RETRY_INTERVAL_MS`, right after a company's config or a certificate changes (only that company's invoices), and from `POST /api/invoices/retry` (the caller's company). It takes invoices waiting for their issuer (once it is ready), transient issues that are due, and invoices without an issue that haven't moved for 5 minutes (lost event). Each company's issuer is checked on its own: one that can't invoice doesn't hold back another. It assumes a single instance of the service.
- **Readiness** (`IssuerReadinessService`, `GET /api/invoicing/status`), per company: config saved and valid (13-digit RUC), an SRI environment this deployment reaches (only `NODE_ENV=production` reaches production), a certificate of its RUC selected, present, not expired and readable with its stored password. Warnings: certificate expiring within 30 days, SRI test environment. Cached for a minute per company and refreshed on that company's config or certificate changes.

### Numbering

The SRI number (`secuencial`, 9 digits) is per company, establishment, emission point and document type (`sequences`). `PrepareInvoice` takes it in the same transaction that stores it on the invoice (`INSERT ... ON CONFLICT DO UPDATE SET last_value = last_value + 1 RETURNING`): concurrent invoices of an emission point get consecutive numbers, none twice, and a failed save gives it back. The first invoice of an emission point is `000000001`, unless `PUT /api/sequences/{establishment}/{emissionPoint}` set where it continues (for example after a previous system); that value never goes back (`SEQUENCE_CANNOT_GO_BACK`, 409), and saving the fiscal profile never moves a counter. `uq_invoices_tenant_number` refuses the same number twice in an emission point; a rejected invoice keeps its number.

---

## Modules

### `invoice`

Core business module. Manages the full invoice lifecycle.

| Layer | Contents |
|-------|----------|
| `domain/` | `Invoice` entity, `AccessCode` VO, `InvoiceIssue`, `ValidationVoucher`, `AuthorizationVoucher`, port interfaces, domain events |
| `app/` | `ReceiveSaleCommand`, `PrepareInvoiceCommand`, `SignInvoiceCommand`, `SendInvoiceCommand`, `AuthorizeInvoiceCommand`, `RetryInvoiceCommand`, `InvoiceEventHandler`, `SaleConfirmedHandler`, `InvoiceRecoveryService`, list/get/status queries |
| `infra/` | `PgInvoiceRepository`, `SignerAdapter`, `SriValidationAdapter`, `SriAuthorizationAdapter`, `XadesSigner`, `P12Reader`, Kafka consumer/producer, `RecoveryScheduler`, HTTP routes |

### `certificate`

Manages PKCS#12 digital signing certificates.

| Layer | Contents |
|-------|----------|
| `domain/` | `Certificate` entity, `P12ParserPort`, `SecretCipherPort` |
| `app/` | `UploadCertificateCommand`, `GetCertificateCommand`, `ListCertificatesCommand`, `DeleteCertificateCommand`, `CertificateKeyLoader` |
| `infra/` | `PgCertificateRepository`, `P12ParserAdapter`, HTTP routes |

Each certificate belongs to a company and keeps its `.p12` file and its password in the database, both encrypted (AES-256-GCM, key in `CERTIFICATE_PASSWORD_KEY`); signing uses the certificate the company's profile selects. On upload:

- The company's fiscal profile must exist (`ISSUER_NOT_CONFIGURED`, 409): the certificate is checked against its RUC.
- The RUCs and cédulas the certificate names are read from its subject (`serialNumber`, `UID`, `organizationIdentifier`) and from the CA's private extensions (`1.3.6.1.4.1.*`, where the BCE, Security Data and others write them): `taxIds`. One must be the issuer's RUC, or its cédula when the RUC is the cédula plus `001` (a natural person). Otherwise `CERTIFICATE_RUC_MISMATCH` (422); without any, `CERTIFICATE_RUC_UNKNOWN` (422).
- Expired certificates are rejected; the expiry date (`validTo`) is kept and readiness warns 30 days before.

Selecting a certificate in the profile checks the same: it must be one of the company's certificates and name its RUC. The selected one can't be deleted (`CERTIFICATE_IN_USE`, 409).

### `company-config`

The fiscal profile of each company (RUC, names, main address, SRI environment, special taxpayer and withholding agent resolutions, RIMPE regime, accounting) and its invoice sequences. The establishment, its address and the emission point are not in the profile: each sale brings them.

| Layer | Contents |
|-------|----------|
| `domain/` | `CompanyConfig` entity, sequences, readiness types |
| `app/` | `SaveCompanyConfigCommand`, `GetCompanyConfigQuery`, `ListSequencesQuery`, `SetNextSequenceCommand`, `IssuerReadinessService` |
| `infra/` | `PgCompanyConfigRepository`, `PgSequenceRepository`, HTTP routes |

---

## HTTP API

Interactive docs available at `http://localhost:3173/docs` (Scalar UI) when the service is running. Every route works on the company of the token (`tid`): another company's invoice, certificate or profile answers as one that doesn't exist.

### Invoices

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/invoicing/status` | Whether the company's issuer can invoice, with issues and counts |
| `GET` | `/api/invoices` | One page of invoices, latest first, with `meta.pagination` (`limit` 1-1000, default 100; `offset`; `status`; `fromDate`/`toDate`, days in Ecuador; `attention=true`: only pending or failed ones) |
| `GET` | `/api/invoices/by-sale/:saleId` | Invoices of a sale |
| `GET` | `/api/invoices/:id` | Get invoice by ID |
| `POST` | `/api/invoices/:id/retry` | Run the next step of an unfinished invoice now |
| `POST` | `/api/invoices/retry` | Retry every invoice that needs attention, in the background (202) |

### Certificates

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/certificates` | Upload a `.p12` certificate (`multipart/form-data`) |
| `GET` | `/api/certificates` | List the company's certificates |
| `GET` | `/api/certificates/:id` | Get certificate by ID |
| `DELETE` | `/api/certificates/:id` | Delete certificate |

### Company Config

| Method | Path | Description |
|--------|------|-------------|
| `PUT` | `/api/company-config` | Create or update the company's fiscal profile (`branchCode`, `salePointCode`, `branchAddress` and `invoiceSequence` are ignored) |
| `GET` | `/api/company-config` | Get the company's fiscal profile |
| `GET` | `/api/sequences` | The company's invoice counters, by establishment and emission point |
| `PUT` | `/api/sequences/:establishment/:emissionPoint` | Where the numbering of an emission point continues (`{ "nextSequence": 42 }`), never backwards |

### Health

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Service health check |

---

## API Response Format

All endpoints return a consistent JSON envelope.

### Success

```json
{
  "data": { } ,
  "meta": {
    "requestId": "73e47c92-cfa9-49a6-86c5-c027a0adb6ae",
    "timestamp": "2026-04-08T14:31:02.563Z"
  }
}
```

`data` can be an object (single resource) or an array (collection). `meta` is always present.

### Error

```json
{
  "errors": [
    {
      "code": "NOT_FOUND",
      "message": "Invoice not found"
    }
  ],
  "meta": {
    "requestId": "73e47c92-cfa9-49a6-86c5-c027a0adb6ae",
    "timestamp": "2026-04-08T14:31:02.563Z"
  }
}
```

#### Error codes

| Code | HTTP status | When |
|------|-------------|------|
| `NOT_FOUND` | 404 | Resource does not exist |
| `BAD_REQUEST` | 400 | Invalid input (missing file, wrong extension, etc.) |
| `VALIDATION_ERROR` | 422 | Request body fails schema validation, unreadable or expired certificate, unknown `signingCertId` |
| `CERTIFICATE_RUC_MISMATCH` | 422 | The certificate names another RUC (upload or selection) |
| `CERTIFICATE_RUC_UNKNOWN` | 422 | The certificate names no RUC nor cédula |
| `ISSUER_NOT_CONFIGURED` | 409 | Uploading a certificate before saving the fiscal profile |
| `CERTIFICATE_IN_USE` | 409 | Deleting the certificate selected in the company config |
| `SEQUENCE_CANNOT_GO_BACK` | 409 | Setting a sequence below a number already issued |
| `INVOICE_NOT_RETRYABLE` | 409 | Retrying an invoice that is already authorized or rejected |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

### Request ID propagation

Every response includes a `requestId` in `meta`. If the request carries an `X-Request-ID` header, that value is used as-is (useful for distributed tracing). Otherwise a UUID v4 is generated automatically.

```bash
curl -H "X-Request-ID: my-trace-id" http://localhost:3173/api/invoices
# → meta.requestId will be "my-trace-id"
```

---

## Kafka Topics

| Topic | Direction | Schema |
|-------|-----------|--------|
| `sales.confirmed` | Inbound | Contracts `contracts/events/sales.confirmed/v2.schema.json` (and v1); validated with `SaleConfirmedMessageSchema` (`messaging/schemas.ts`) |
| `invoices` | Inbound + Outbound | Contract `contracts/events/invoices/v1.schema.json`; domain events (`InvoiceReceived`, `InvoiceCreated`, `InvoiceSigned`, `InvoiceSent`, `InvoiceAuthorized`, `InvoiceRejected`) sent through `toInvoiceMessage` and read with `InvoiceMessageSchema` |

The service acts as both producer and consumer on the `invoices` topic to implement the state machine. faclab-core also reads `invoices` with its own consumer group: on `InvoiceAuthorized` it marks the sale as `INVOICED`. Each `invoices` message carries the invoice's company as its key and in the `faclab-tenant-id` header (not in the body, whose v1 schema is closed): faclab-core opens that company's context with it.

**Which company, from where.** `sales.confirmed` v2 brings `tenant_id` (the company), `issuer_ruc`, `establishment_code`, `establishment_address` and `emission_point_code`. The invoice is issued with that company's profile, certificate and sequence, and the XML's `estab`, `ptoEmi` and `dirEstablecimiento` (left out when the address is `null`) are the message's; `dirMatriz` is the profile's main address. v1 names none of them: only a development setup invoices it, with the company in `SALES_V1_TENANT_ID`, at `001`-`001` and without checking the RUC; elsewhere it goes to the DLQ.

Each `sales.confirmed` item carries `invoice_discount`, `invoice_base` and `invoice_tax`: the line's `descuento`, `precioTotalSinImpuesto`/`baseImponible` and IVA `valor`, already rounded to cents and with the sale-level discount prorated by faclab-core. The XML uses them as they are (the SRI invoice has no sale-level discount), so the bases plus VAT add up to the sale total. Money is summed in cents and written with two decimals.

### Event contracts

The messages follow versioned JSON Schemas owned by faclab-core (`faclab-core/contracts/`, see its README for the field-by-field contract and the compatibility policy). `contracts/` here is a copy pinned to a faclab-core commit in `contracts/source.json`:

- `npm run contracts:sync -- <commit|branch|tag>` refreshes it from GitHub (`CORE_REPO=../faclab-core` uses a local clone instead, for a branch not pushed yet). Never edit the copy by hand: CI checks it out from faclab-core at the pinned commit and fails on any difference.
- `npm run test:contract` (`test/contract/`) parses every `sales.confirmed` example (v1 and v2) with zod and builds its invoice XML, checks that v2's XML and access code use the message's establishment, address and emission point, and validates every message this service publishes on `invoices` against its schema (ajv).
- `sales.confirmed` is accepted in v2 and v1; `invoices` carries `schema_version: 1`. A message without `schema_version` predates v1 and is read as v1; any other version fails validation and goes to the DLQ.
- A customer may come without `email`, `phone` or `address` (`null`): the SRI doesn't require them and the XML leaves them out (`infoAdicional` only when there is at least one). A final consumer (`customer: null`) is invoiced as `07` / `9999999999999` / `CONSUMIDOR FINAL`. An item without `sku` has no `codigoAuxiliar`; one without `product_name` (the product no longer exists in faclab-core) is described as `Producto <product_id>`.

When a contract changes, deploy the consumer before the producer.

---

## Persistence

PostgreSQL, in a database of its own (`faclab_invoicing`; locally faclab-infra's `invoicing-db` on `localhost:5434`). Repositories use `pg` with plain SQL (`src/modules/*/infra/persistence/pg-*.repository.ts`) and the pool from `src/shared/infra/database.ts`.

| Table | Contents |
|-------|----------|
| `invoices` | One row per invoice: company (`tenant_id`), sale, RUC, establishment, address and emission point of the sale, status, sequence, access code, XML, current issue, `version`. Indexes by company and sale, status and creation date; `uq_invoices_active_sale` allows one invoice that isn't `rejected` per company and sale; `uq_invoices_tenant_number` one invoice per number of an emission point |
| `invoice_events` | Status history of each invoice, in order (append-only) |
| `issuers` | The fiscal profile of each company (key `tenant_id`) |
| `sequences` | Last number issued per company, establishment, emission point and document type (`'01'` = factura). See [Numbering](#numbering) |
| `certificates` | Certificates of each company: metadata, the RUCs and cédulas they name (`tax_ids`), the `.p12` and its password, both encrypted. An issuer can only select one of its company (composite foreign key `fk_issuers_signing_cert_tenant`) |

**Isolation between companies** is a filter the application never skips: every repository method the API uses takes the company and puts it in the `WHERE`; the pipeline (Kafka, recovery) moves invoices by id and uses each invoice's company. The database has a single role for now: separate owner and application roles, and row-level security like faclab-core's, are pending.

**Migrations** are plain SQL files in `migrations/`, applied with [node-pg-migrate](https://salsita.github.io/node-pg-migrate/) (table `pgmigrations`, advisory lock, up and down). They run as a separate step before starting a new version, like faclab-core's `make upgrade`:

```bash
npm run migrate up                                   # apply pending migrations (reads DATABASE_URL)
npm run migrate down                                 # roll back the last one
npm run migrate create <name> -- -j sql              # new SQL migration in migrations/
```

`npm run migrate` reads `DATABASE_URL` from the environment or `.env` (the service's local default doesn't apply to it). The production image includes `migrations/`: `docker run --rm -e DATABASE_URL=... faclab-invoicing npm run migrate up`.

---

## Configuration

`NODE_ENV` picks the mode: `local` (the default) or `production`; any other value stops the service. Every setting comes from an environment variable, validated with zod in `src/config/` when the process starts:

- **Local:** every variable has a default that points at [faclab-infra](https://github.com/faclab-ec/faclab-infra) from the host.
- **Production:** the variables that depend on where the service runs have no default. If any is missing or invalid, the process exits with code 1 and lists them by name, never by value:

  ```text
  Invalid configuration for NODE_ENV=production:
  - KAFKA_BROKERS is required
  - DATABASE_URL is required
  ```

`npm run dev` and `npm start` load `.env` when it exists (`node --env-file-if-exists`); variables already set in the environment win. `.env.example` lists them all.

### Environment Variables

| Variable | Local default | Production | Description |
|----------|---------------|------------|-------------|
| `KAFKA_BROKERS` | `localhost:29092` | **Required** | Comma-separated brokers. A container on `faclab_network` uses `kafka:9092` |
| `DATABASE_URL` | `postgres://faclab_invoicing:faclab_invoicing@localhost:5434/faclab_invoicing` | **Required** | PostgreSQL connection string (`postgres://` or `postgresql://`). A container on `faclab_network` uses `invoicing-db:5432` |
| `CORS_ORIGINS` | `http://localhost:5173` | **Required**, without `*` | Comma-separated origins allowed to call the API (faclab-web) |
| `JWT_SECRET` | `dev-only-change-me`, same as faclab-core | **Required**, 32+ characters | faclab-core's `JWT_SECRET` |
| `CERTIFICATE_PASSWORD_KEY` | Fixed dev key | **Required** | 32 random bytes in base64 (`openssl rand -base64 32`); encrypts the certificate files and passwords. Losing or changing it makes stored certificates unreadable: upload them again |
| `JWT_ISSUER` | `faclab-core` | Optional | faclab-core's `JWT_ISSUER` |
| `HTTP_PORT` | `3173` | Optional | HTTP server port |
| `LOG_LEVEL` | `debug` | Optional (`info`) | pino level |
| `SRI_TIMEOUT_MS` | `30000` | Optional | Timeout for each SRI SOAP call |
| `INVOICE_RETRY_INTERVAL_MS` | `60000` | Optional | How often the recovery runs |
| `SALES_V1_TENANT_ID` | — | **Refused** | Development only: the company (faclab-core tenant id) that invoices `sales.confirmed` v1, which names none. Without it a v1 message goes to the DLQ |
| `SERVICE_VERSION` | `dev` | Set by the image build | Tag or commit SHA: `service.version` in logs and traces, and the API docs version |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4317` | Optional | OTLP gRPC endpoint for traces, metrics and logs, read by `src/instrumentation.ts`. Locally, SigNoz's collector (see [Observability](#observability)) |
| `OTEL_SDK_DISABLED` | — | Optional | `true` turns OpenTelemetry off |

### Authentication

Every `/api/*` route needs a faclab-core access token (`Authorization: Bearer ...`); `/health` and `/docs` are public. Tokens are verified with the shared `JWT_SECRET` (HS256), `JWT_ISSUER` and `typ=access`; the token's `tid` is the company the request works on (a token without it gets 401 `TENANT_REQUIRED`, like in faclab-core), and the route's permission must be in its `perms` claim:

| Routes | Permission |
|--------|------------|
| `/api/company-config`, `/api/certificates`, `/api/sequences` | `user:manage` |
| `GET /api/invoices`, `GET /api/invoicing/status` | `sale:read` |
| `POST /api/invoices/retry`, `POST /api/invoices/:id/retry` | `sale:write` |

Errors use faclab-core's codes so faclab-web handles them the same way: `TOKEN_EXPIRED` / `INVALID_TOKEN` / `TENANT_REQUIRED` (401), `PERMISSION_DENIED` / `PASSWORD_CHANGE_REQUIRED` (403).

### SRI environment

Each issuer has its environment (`environment` in the fiscal profile): it goes into the access code and the XML `ambiente`, and picks the SRI web services its invoices are sent to. The URLs live in a single table, `src/config/sri.ts`:

| `environment` | Host | Invoices |
|---------------|------|----------|
| `1` (testing) | `celcer.sri.gob.ec` | Testing, without tax validity |
| `2` (production) | `cel.sri.gob.ec` | Real, with tax validity |

- `NODE_ENV=production` reaches both; each company picks its own, so one company can test while another invoices for real.
- Local only reaches the test web services: an issuer set to production gets `ENVIRONMENT_NOT_ALLOWED` and its invoices wait.
- Sending and authorizing use the environment of the invoice's access code, so an invoice already prepared finishes where it started even if the profile changes.
- Every startup logs the environments it reaches.

---

## Observability

`src/instrumentation.ts` starts the OpenTelemetry SDK before anything else (`node -r`) and exports traces, metrics and logs over OTLP gRPC. The standard shared with faclab-core is in faclab-core's `docs/architecture/OBSERVABILITY.md`.

- **Resource**: `service.name` (`OTEL_SERVICE_NAME`, default `faclab-invoicing`), `service.namespace=faclab`, `service.version` (`SERVICE_VERSION`) and `deployment.environment.name` (`NODE_ENV`).
- **Kafka traces**: consuming a message creates `process <topic>` (kind CONSUMER) as a child of the producer's span, and sending one creates `send <topic>` (kind PRODUCER) and injects that span's context. A POS sale therefore shows as one trace: faclab-core's `send sales.confirmed` → `process sales.confirmed` here → `send invoices` → faclab-core's `process invoices`.
- **Logs**: pino, with `trace_id` and `span_id` added by the pino instrumentation. Passwords, tokens, `authorization`, cookies, secrets, `p12`, certificates, private keys, XML and signatures are replaced by `[REDACTED]` at any depth, before the line reaches stdout or OTLP (`src/shared/logger.ts`). Outside `local`, each line carries `service.name`, `service.version` and `deployment.environment.name`.
- **Database**: each query inside a request or a Kafka message gets a span (`@opentelemetry/instrumentation-pg`); the recovery job's polling, outside any span, doesn't start traces.
- **Shutdown**: on SIGTERM or SIGINT the service closes Kafka, HTTP and the database pool, then flushes the telemetry still buffered (up to 5 s) and logs `Telemetry flushed` before exiting.

To see it locally, start SigNoz with faclab-infra (`scripts/signoz.sh up`, UI at `http://localhost:8080`). From the host, the default endpoint (`http://localhost:4317`) already reaches its collector; a container on `faclab_network` uses `http://signoz-otel-collector:4317`.

---

## Local Development

### Prerequisites

- Node.js 22.9 or later (CI uses 22)
- Docker, for faclab-infra (Kafka and the invoicing PostgreSQL)

### Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Start faclab-infra** (Kafka and `invoicing-db`, which creates the `faclab_invoicing` and `faclab_invoicing_test` databases)

   ```bash
   cd ../faclab-infra && docker compose up -d
   ```

3. **Configure environment**

   ```bash
   cp .env.example .env
   ```

   The local defaults already point at faclab-infra; `.env` adds `DATABASE_URL` for `npm run migrate` and whatever you override.

4. **Create the tables**

   ```bash
   npm run migrate up
   ```

5. **Run in dev mode**

   ```bash
   npm run dev
   ```

   The service starts on `http://localhost:3173`.

### Available Scripts

```bash
npm run dev           # ts-node-dev with hot reload (loads .env)
npm run build         # tsc → dist/, then tsc-alias rewrites the #/ imports
npm run start         # Run compiled output (loads .env)
npm run lint          # ESLint check
npm run lint:fix      # ESLint auto-fix
npm run format        # Prettier format
npm run format:check  # Prettier check
npm run typecheck     # tsc over src and test
npm test              # vitest (test/); test/postgres only runs with TEST_DATABASE_URL
npm run test:postgres # only the PostgreSQL tests
npm run migrate       # node-pg-migrate (up, down, create); reads DATABASE_URL
```

### Tests against PostgreSQL

`test/postgres/` checks the repositories, the single active invoice per sale (concurrent resends), the invoice sequence and the full flow on a real database. They are skipped unless `TEST_DATABASE_URL` points at a database whose name ends in `_test` (faclab-infra creates `faclab_invoicing_test`). Each file migrates a schema of its own and drops it at the end; each test starts with empty tables.

```bash
TEST_DATABASE_URL=postgres://faclab_invoicing:faclab_invoicing@localhost:5434/faclab_invoicing_test npm test
```

### Continuous Integration

Every pull request and push to `master` runs `.github/workflows/ci.yml` on GitHub Actions:

- `checks` (Node 22, with a `postgres:17` service and `TEST_DATABASE_URL`, so `test/postgres` runs): `npm ci`, then `lint`, `format:check`, `typecheck`, `test` and `build`.
- `image`: builds the production image without publishing it, and checks that it refuses to start without `KAFKA_BROKERS`, `DATABASE_URL` and `JWT_SECRET`.

`package-lock.json` is versioned so `npm ci` installs exactly what was tested; commit it whenever dependencies change.

To run the same locally:

```bash
npm ci && npm run lint && npm run format:check && npm run typecheck && npm test && npm run build
```

### First-Run Setup

Each company sets up its issuer with a token of its own (`tid`) and the `user:manage` permission. Until this is done, its sales wait as `pending` invoices (see `GET /api/invoicing/status`); finishing it resumes them. The establishments and emission points come from faclab-core (branches and POS terminals).

1. **Save the fiscal profile** (the RUC is the company's, as in faclab-core)

   ```bash
   curl -X PUT http://localhost:3173/api/company-config \
     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{
       "taxId": "1234567890001",
       "name": "ACME S.A.",
       "tradeName": "ACME",
       "mainAddress": "Av. Principal 123",
       "accountingRequired": false,
       "environment": 1,
       "emissionType": 1
     }'
   ```

2. **Upload its signing certificate**: it must name that RUC (or the cédula of a natural person)

   ```bash
   curl -X POST http://localhost:3173/api/certificates \
     -H "Authorization: Bearer $TOKEN" \
     -F "file=@/path/to/certificate.p12" \
     -F "password=your-p12-password"
   # Copy the returned `id`
   ```

3. **Select it**: the same profile with `"signingCertId": "<id from step 2>"`.

4. **Optionally, continue a previous numbering**: `PUT /api/sequences/001/001` with `{ "nextSequence": 1234 }` before the first invoice of that emission point.

---

## Docker

`Dockerfile` builds the production image (`--target production`):

- `node:22-bookworm-slim`, the same Node and glibc as CI, so the prebuilt librdkafka binary of `@confluentinc/kafka-javascript` matches the runtime.
- Stages `build` (`npm ci` and `npm run build`), `deps` (production dependencies only) and `production`.
- Runs as `app` (uid 10001), with the code owned by root.
- `NODE_ENV=production`, port `3173`, and a `HEALTHCHECK` on `/health` with Node's `fetch`.
- Starts with `node -r ./dist/instrumentation.js dist/server.js`. It doesn't migrate the database: run `npm run migrate up` with the same image first.
- `SERVICE_VERSION` comes from the build: `--build-arg SERVICE_VERSION=$(git rev-parse --short HEAD)` (CI passes the commit SHA); without it the image reports `dev`.

`.dockerignore` keeps `.env`, `.git`, tests and docs out of the image.

To run it against faclab-infra (Kafka and `invoicing-db` on `faclab_network`), reaching both SRI environments (each issuer picks its own):

```bash
docker build --target production -t faclab-invoicing .

DATABASE_URL=postgres://faclab_invoicing:faclab_invoicing@invoicing-db:5432/faclab_invoicing
docker run --rm --network faclab_network -e DATABASE_URL=$DATABASE_URL faclab-invoicing npm run migrate up

docker run --rm --network faclab_network -p 3173:3173 \
  -e KAFKA_BROKERS=kafka:9092 \
  -e DATABASE_URL=$DATABASE_URL \
  -e CORS_ORIGINS=http://localhost:5173 \
  -e JWT_SECRET='<faclab-core JWT_SECRET>' \
  -e CERTIFICATE_PASSWORD_KEY='<32 bytes in base64>' \
  -e OTEL_SDK_DISABLED=true \
  faclab-invoicing
```

To run it next to a local faclab-core, use the local defaults instead, including the dev keys and the same `JWT_SECRET`. Pass only `-e NODE_ENV=local`, `KAFKA_BROKERS` and `DATABASE_URL`.

---

## Project Structure

```
migrations/                      # SQL migrations (node-pg-migrate)
src/
├── server.ts                    # Entry point
├── container.ts                 # Composition root (manual DI)
├── config/
│   ├── index.ts                 # AppConfig and its zod validation (parseConfig)
│   ├── local.ts                 # Local defaults
│   ├── production.ts            # Production defaults and rules
│   └── sri.ts                   # SRI endpoints of each environment
├── modules/
│   ├── invoice/
│   │   ├── domain/
│   │   │   ├── invoice.ts
│   │   │   ├── access-code.ts
│   │   │   ├── access-code-generator.ts
│   │   │   ├── invoice-xml-builder.ts
│   │   │   ├── sri-catalogs.ts
│   │   │   ├── voucher.ts
│   │   │   ├── events.ts
│   │   │   └── ports.ts
│   │   ├── app/
│   │   │   ├── commands/        # create, sign, send, authorize
│   │   │   ├── handlers/        # invoice-event, sale-confirmed
│   │   │   └── queries/         # get, list
│   │   └── infra/
│   │       ├── adapters/        # signer, sri-clients, sri-validation, sri-authorization
│   │       ├── http/            # routes, schemas, mappers
│   │       ├── messaging/       # kafka consumer, producer, schemas, topics
│   │       ├── persistence/     # PostgreSQL repo, row mapper
│   │       └── signing/         # xades-signer, p12-reader
│   ├── certificate/
│   │   ├── domain/
│   │   ├── app/
│   │   └── infra/
│   │       ├── adapters/        # p12-parser
│   │       ├── http/
│   │       └── persistence/
│   └── company-config/
│       ├── domain/
│       ├── app/
│       └── infra/
│           ├── http/
│           └── persistence/
└── shared/
    ├── logger.ts
    └── infra/
        ├── database.ts          # pg pool and transactions
        ├── http-server.ts       # Fastify + Swagger setup
        ├── kafka.ts             # BaseKafkaConsumer
        ├── soap-client.ts       # strong-soap wrapper
        └── p12.ts               # P12 parsing utilities
```
