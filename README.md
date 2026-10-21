# Faclab Invoicing — Electronic Invoice Service

Event-driven microservice that integrates with Ecuador's **SRI** (Servicio de Rentas Internas) tax authority. It listens to sale confirmation events from Kafka, generates compliant electronic invoice XML, signs it with XAdES-BES, submits it to SRI SOAP endpoints for validation and authorization, and persists the full invoice lifecycle in PostgreSQL.

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

- **The sale is stored first.** `ReceiveSale` saves a `pending` invoice with the sale data before looking at the config, so a sale confirmed while the fiscal config or the certificate are missing waits instead of failing. `PrepareInvoice` assigns the sequence (once) and builds the XML when the issuer is ready. The emission date is the day the XML is built.
- **Idempotent.** The invoice id is a UUID v5 of the message's `event_id`: the same message twice creates one invoice. A resend from faclab-core (new `event_id`) is ignored while the sale has an invoice that isn't `rejected`; the partial unique index `uq_invoices_active_sale` keeps that true when two resends arrive at the same time. Updates check a `version` column (optimistic locking).
- **A failed step is recorded, not thrown.** The invoice keeps its status and gets an `issue` (`code`, `message`, `at`), `attempts` and `nextAttemptAt`; the next transition clears it. The `dlq` topic is left for malformed messages and storage outages.
  - Issuer problems (`CONFIG_MISSING`, `CONFIG_INVALID`, `CERTIFICATE_NOT_SELECTED`, `CERTIFICATE_NOT_FOUND`, `CERTIFICATE_EXPIRED`, `CERTIFICATE_UNREADABLE`) wait until the issuer is ready.
  - `SRI_UNAVAILABLE` (SOAP error or timeout), `SRI_PROCESSING` (no authorization yet, or `EN PROCESO`) and `UNEXPECTED_ERROR` are retried after 1, 5, 15 and then every 60 minutes, up to 10 attempts; after that only by hand.
  - A reception `DEVUELTA` whose only messages are 43 (access code already registered) or 70 (access code being processed) means the SRI already has the voucher: the invoice moves on to authorization.
- **Recovery** (`InvoiceRecoveryService`) runs at start, every `INVOICE_RETRY_INTERVAL_MS`, right after the config or a certificate changes, and from `POST /api/invoices/retry`. It takes invoices waiting for the issuer (once it is ready), transient issues that are due, and invoices without an issue that haven't moved for 5 minutes (lost event). It assumes a single instance of the service.
- **Readiness** (`IssuerReadinessService`, `GET /api/invoicing/status`): config saved and valid (13-digit RUC, 3-digit branch and point of sale), a certificate selected, present, not expired and readable with its stored password. Warnings: certificate expiring within 30 days, SRI test environment. Cached for a minute and refreshed on config or certificate changes.

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

Each certificate keeps its `.p12` file and its password in the database, both encrypted (AES-256-GCM, key in `CERTIFICATE_PASSWORD_KEY`); signing uses the selected certificate. Expired certificates are rejected on upload, and the selected one can't be deleted (`CERTIFICATE_IN_USE`, 409).

### `company-config`

Singleton fiscal configuration for the company (RUC, addresses, SRI environment, etc.).

| Layer | Contents |
|-------|----------|
| `domain/` | `CompanyConfig` entity, readiness types |
| `app/` | `SaveCompanyConfigCommand`, `GetCompanyConfigQuery`, `IssuerReadinessService` |
| `infra/` | `PgCompanyConfigRepository` (with the invoice sequence), HTTP routes |

---

## HTTP API

Interactive docs available at `http://localhost:3173/docs` (Scalar UI) when the service is running.

### Invoices

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/invoicing/status` | Whether the issuer can invoice, with issues and counts |
| `GET` | `/api/invoices` | One page of invoices, latest first, with `meta.pagination` (`limit` 1-1000, default 100; `offset`; `status`; `fromDate`/`toDate`, days in Ecuador; `attention=true`: only pending or failed ones) |
| `GET` | `/api/invoices/by-sale/:saleId` | Invoices of a sale |
| `GET` | `/api/invoices/:id` | Get invoice by ID |
| `POST` | `/api/invoices/:id/retry` | Run the next step of an unfinished invoice now |
| `POST` | `/api/invoices/retry` | Retry every invoice that needs attention, in the background (202) |

### Certificates

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/certificates` | Upload a `.p12` certificate (`multipart/form-data`) |
| `GET` | `/api/certificates` | List all certificates |
| `GET` | `/api/certificates/:id` | Get certificate by ID |
| `DELETE` | `/api/certificates/:id` | Delete certificate |

### Company Config

| Method | Path | Description |
|--------|------|-------------|
| `PUT` | `/api/company-config` | Create or update fiscal config |
| `GET` | `/api/company-config` | Get current fiscal config |

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
| `CERTIFICATE_IN_USE` | 409 | Deleting the certificate selected in the company config |
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
| `sales.confirmed` | Inbound | Contract `contracts/events/sales.confirmed/v1.schema.json`; validated with `SaleConfirmedMessageSchema` (`messaging/schemas.ts`) |
| `invoices` | Inbound + Outbound | Contract `contracts/events/invoices/v1.schema.json`; domain events (`InvoiceReceived`, `InvoiceCreated`, `InvoiceSigned`, `InvoiceSent`, `InvoiceAuthorized`, `InvoiceRejected`) sent through `toInvoiceMessage` and read with `InvoiceMessageSchema` |

The service acts as both producer and consumer on the `invoices` topic to implement the state machine. faclab-core also reads `invoices` with its own consumer group: on `InvoiceAuthorized` it marks the sale as `INVOICED`.

Each `sales.confirmed` item carries `invoice_discount`, `invoice_base` and `invoice_tax`: the line's `descuento`, `precioTotalSinImpuesto`/`baseImponible` and IVA `valor`, already rounded to cents and with the sale-level discount prorated by faclab-core. The XML uses them as they are (the SRI invoice has no sale-level discount), so the bases plus VAT add up to the sale total. Money is summed in cents and written with two decimals.

### Event contracts

The messages follow versioned JSON Schemas owned by faclab-core (`faclab-core/contracts/`, see its README for the field-by-field contract and the compatibility policy). `contracts/` here is a copy pinned to a faclab-core commit in `contracts/source.json`:

- `npm run contracts:sync -- <commit|branch|tag>` refreshes it from GitHub (`CORE_REPO=../faclab-core` uses a local clone instead, for a branch not pushed yet). Never edit the copy by hand: CI checks it out from faclab-core at the pinned commit and fails on any difference.
- `npm run test:contract` (`test/contract/`) parses every `sales.confirmed` example with zod and builds its invoice XML, and validates every message this service publishes on `invoices` against its schema (ajv).
- Both messages carry `schema_version: 1`. A message without it predates v1 and is read as v1; any other version fails validation and goes to the DLQ.
- A customer may come without `email`, `phone` or `address` (`null`): the SRI doesn't require them and the XML leaves them out (`infoAdicional` only when there is at least one). A final consumer (`customer: null`) is invoiced as `07` / `9999999999999` / `CONSUMIDOR FINAL`. An item without `sku` has no `codigoAuxiliar`; one without `product_name` (the product no longer exists in faclab-core) is described as `Producto <product_id>`.

When a contract changes, deploy the consumer before the producer.

---

## Persistence

PostgreSQL, in a database of its own (`faclab_invoicing`; locally faclab-infra's `invoicing-db` on `localhost:5434`). Repositories use `pg` with plain SQL (`src/modules/*/infra/persistence/pg-*.repository.ts`) and the pool from `src/shared/infra/database.ts`.

| Table | Contents |
|-------|----------|
| `invoices` | One row per invoice: status, sale received, sequence, access code, XML, current issue, `version`. Indexes by sale, status and creation date; `uq_invoices_active_sale` allows one invoice that isn't `rejected` per sale |
| `invoice_events` | Status history of each invoice, in order (append-only) |
| `issuers` | The fiscal profile (one row, `id = 'default'`, until S2.8) |
| `sequences` | Last invoice number issued (`doc_type = '01'`). `UPDATE ... RETURNING` hands out each number once, also to concurrent callers; the first invoice of a new issuer is `000000001`. Saving the config only moves it when the request brings `invoiceSequence` (the number the next invoice will get) |
| `certificates` | Certificate metadata, the `.p12` and its password, both encrypted |

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
  - SRI_ENVIRONMENT is required
  - KAFKA_BROKERS is required
  - DATABASE_URL is required
  ```

`npm run dev` and `npm start` load `.env` when it exists (`node --env-file-if-exists`); variables already set in the environment win. `.env.example` lists them all.

### Environment Variables

| Variable | Local default | Production | Description |
|----------|---------------|------------|-------------|
| `SRI_ENVIRONMENT` | `test` (`production` is refused) | **Required** | SRI web services: `test` or `production`. See [SRI environment](#sri-environment) |
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
| `SERVICE_VERSION` | `dev` | Set by the image build | Tag or commit SHA: `service.version` in logs and traces, and the API docs version |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4317` | Optional | OTLP gRPC endpoint for traces, metrics and logs, read by `src/instrumentation.ts`. Locally, SigNoz's collector (see [Observability](#observability)) |
| `OTEL_SDK_DISABLED` | — | Optional | `true` turns OpenTelemetry off |

### Authentication

Every `/api/*` route needs a faclab-core access token (`Authorization: Bearer ...`); `/health` and `/docs` are public. Tokens are verified with the shared `JWT_SECRET` (HS256), `JWT_ISSUER` and `typ=access`, and the route's permission must be in the token's `perms` claim:

| Routes | Permission |
|--------|------------|
| `/api/company-config`, `/api/certificates` | `user:manage` |
| `GET /api/invoices`, `GET /api/invoicing/status` | `sale:read` |
| `POST /api/invoices/retry`, `POST /api/invoices/:id/retry` | `sale:write` |

Errors use faclab-core's codes so faclab-web handles them the same way: `TOKEN_EXPIRED` / `INVALID_TOKEN` (401), `PERMISSION_DENIED` / `PASSWORD_CHANGE_REQUIRED` (403).

### SRI environment

`SRI_ENVIRONMENT` picks the SRI web services (reception and authorization WSDLs) the process calls. The URLs live in a single table, `src/config/sri.ts`:

| Value | Host | Invoices |
|-------|------|----------|
| `test` | `celcer.sri.gob.ec` | Testing, without tax validity |
| `production` | `cel.sri.gob.ec` | Real, with tax validity |

- Production has no default, so it can't reach the test environment by accident. A staging deployment sets `NODE_ENV=production` with `SRI_ENVIRONMENT=test`, and the service logs a warning on startup.
- Local refuses `production`.
- Every startup logs `sriEnvironment` and the SRI host.

It is not the issuer's `CompanyConfig.environment`, which goes into the access code and the XML `ambiente`:

| Value | Meaning |
|-------|---------|
| `1` | Testing |
| `2` | Production |

Both must agree: an issuer with `environment: 2` needs `SRI_ENVIRONMENT=production`. Nothing checks this yet; in S2.8 the environment becomes a setting of each issuer.

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
- `image`: builds the production image without publishing it, and checks that it refuses to start without `SRI_ENVIRONMENT`, `KAFKA_BROKERS` and `DATABASE_URL`.

`package-lock.json` is versioned so `npm ci` installs exactly what was tested; commit it whenever dependencies change.

To run the same locally:

```bash
npm ci && npm run lint && npm run format:check && npm run typecheck && npm test && npm run build
```

### First-Run Setup

Until this is done, sales wait as `pending` invoices (see `GET /api/invoicing/status`); saving the config resumes them. Bootstrap the service via the REST API:

1. **Upload a signing certificate**

   ```bash
   curl -X POST http://localhost:3173/api/certificates \
     -F "file=@/path/to/certificate.p12" \
     -F "password=your-p12-password"
   # Copy the returned `id` → use as signingCertId in the next step
   ```

2. **Save company fiscal config** (include the certificate `id` from step 1)

   ```bash
   curl -X PUT http://localhost:3173/api/company-config \
     -H "Content-Type: application/json" \
     -d '{
       "taxId": "1234567890001",
       "name": "ACME S.A.",
       "tradeName": "ACME",
       "mainAddress": "Av. Principal 123",
       "branchAddress": "Av. Principal 123",
       "branchCode": "001",
       "salePointCode": "001",
       "accountingRequired": false,
       "environment": 1,
       "emissionType": 1,
       "signingCertId": "<uuid-from-step-1>"
     }'
   ```

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

To run it against faclab-infra (Kafka and `invoicing-db` on `faclab_network`) with the SRI test environment:

```bash
docker build --target production -t faclab-invoicing .

DATABASE_URL=postgres://faclab_invoicing:faclab_invoicing@invoicing-db:5432/faclab_invoicing
docker run --rm --network faclab_network -e DATABASE_URL=$DATABASE_URL faclab-invoicing npm run migrate up

docker run --rm --network faclab_network -p 3173:3173 \
  -e SRI_ENVIRONMENT=test \
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
│   └── sri.ts                   # SRI endpoints per SRI_ENVIRONMENT
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
│   │       ├── adapters/        # signer, sri-validation, sri-authorization
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
