import { KafkaJS } from '@confluentinc/kafka-javascript';
import { vi } from 'vitest';

import { Certificate } from '#/modules/certificate/domain/certificate';
import { CertificateRepository } from '#/modules/certificate/domain/repository';
import { IssuerReadinessService, ReadyIssuer } from '#/modules/company-config/app/issuer-readiness';
import {
  CompanyConfig,
  EmissionType,
  Environment,
  IssuerLogo,
  RimpeRegime,
} from '#/modules/company-config/domain/company-config';
import { IssuerNotReadyError, ReadinessReport } from '#/modules/company-config/domain/readiness';
import {
  CompanyConfigRepository,
  SequenceRepository,
} from '#/modules/company-config/domain/repository';
import {
  formatSequence,
  INVOICE_DOC_TYPE,
  Sequence,
  SequenceKey,
} from '#/modules/company-config/domain/sequence';
import { AuthorizeInvoiceCommand } from '#/modules/invoice/app/commands/authorize-invoice';
import { InvoiceCommand } from '#/modules/invoice/app/commands/command';
import {
  PrepareInvoiceCommand,
  PrepareInvoiceOptions,
} from '#/modules/invoice/app/commands/prepare-invoice';
import { ReceivedSale } from '#/modules/invoice/app/commands/receive-sale';
import { SendInvoiceCommand } from '#/modules/invoice/app/commands/send-invoice';
import { SignInvoiceCommand } from '#/modules/invoice/app/commands/sign-invoice';
import { AccessCode } from '#/modules/invoice/domain/access-code';
import { authorizedXmlKey } from '#/modules/invoice/domain/authorized-xml';
import { InvoiceDelivery } from '#/modules/invoice/domain/delivery';
import { Invoice, InvoiceStatus } from '#/modules/invoice/domain/invoice';
import { buildInvoiceXml, InvoiceXmlInput } from '#/modules/invoice/domain/invoice-xml-builder';
import { InvoiceIssueError } from '#/modules/invoice/domain/issue';
import {
  DocumentStorage,
  InvoiceSchemaValidator,
  SriAuthorizationPort,
  SriValidationPort,
} from '#/modules/invoice/domain/ports';
import {
  ClaimedDelivery,
  ClaimedInvoice,
  DeliveryQueue,
  InvoiceQueue,
  WaitingInvoice,
} from '#/modules/invoice/domain/queue';
import {
  ConcurrentUpdateError,
  InFlightCounts,
  InvoiceDeliveryRepository,
  InvoiceFilter,
  InvoicePage,
  InvoiceRepository,
  PageRequest,
} from '#/modules/invoice/domain/repository';
import { IssuingPoint, SaleData } from '#/modules/invoice/domain/sale';
import {
  AuthorizationVoucher,
  AuthorizationVoucherStatus,
  ValidationVoucher,
  ValidationVoucherStatus,
} from '#/modules/invoice/domain/voucher';
import { XsdInvoiceSchemaValidator } from '#/modules/invoice/infra/adapters/xsd-validator.adapter';
import { SaleConfirmedV2Message } from '#/modules/invoice/infra/messaging/schemas';
import {
  fromInvoiceRow,
  InvoiceRow,
  toInvoiceEventRows,
  toInvoiceRow,
} from '#/modules/invoice/infra/persistence/invoice.mapper';
import { Authorize } from '#/shared/infra/http/auth';

// Two companies (faclab-core tenants), each with its own RUC
export const TENANT_A = '2b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c6d';
export const TENANT_B = '0b7e5c4d-3a2f-4e1d-9c8b-7a6f5e4d3c2b';
export const RUC_A = '1792141001001';
export const RUC_B = '0990012345001';

// occurred_at of the sales.confirmed messages the helpers build
export const REQUESTED_AT = new Date('2026-10-09T15:00:00Z');

// The SRI's XSD: the invoices the tests build are validated against it, as in the service
export const xsdValidator: InvoiceSchemaValidator = new XsdInvoiceSchemaValidator();

export const PREPARE_OPTIONS: PrepareInvoiceOptions = {
  emissionDate: 'sale',
  finalConsumerMaxTotal: 50,
  providerRuc: null,
};

/** PrepareInvoiceCommand with the real XSD and the service's defaults, unless overridden */
export function prepareCommand(
  readiness: IssuerReadinessService,
  repo: InvoiceRepository,
  overrides: Partial<PrepareInvoiceOptions> & { validator?: InvoiceSchemaValidator } = {},
) {
  const { validator = xsdValidator, ...options } = overrides;
  return new PrepareInvoiceCommand(readiness, repo, validator, {
    ...PREPARE_OPTIONS,
    ...options,
  });
}

/** The SRI, simulated: receives every invoice and authorizes it */
export const simulatedSri: SriValidationPort & SriAuthorizationPort = {
  validateXml: async () =>
    new ValidationVoucher(ValidationVoucherStatus.ACCEPTED, null, ['RECIBIDA']),
  authorizeXml: async (code) =>
    new AuthorizationVoucher(
      AuthorizationVoucherStatus.AUTHORIZED,
      code,
      new Date('2026-10-09T15:01:02Z'),
      ['AUTORIZADO'],
      {
        number: code,
        date: '2026-10-09T10:01:02-05:00',
        environment: 'PRUEBAS',
        voucherXml: '<factura firmada/>',
      },
    ),
};

/** Every step of an invoice, against the simulated SRI unless `sri` replaces part of it */
export function invoiceSteps(
  repo: InvoiceRepository,
  readiness: IssuerReadinessService,
  {
    sri = {},
    storage = new InMemoryDocumentStorage(),
  }: {
    sri?: Partial<SriValidationPort & SriAuthorizationPort>;
    storage?: DocumentStorage;
  } = {},
): Map<InvoiceStatus, InvoiceCommand> {
  const { validateXml, authorizeXml } = { ...simulatedSri, ...sri };
  return new Map<InvoiceStatus, InvoiceCommand>([
    [InvoiceStatus.PENDING, prepareCommand(readiness, repo)],
    [
      InvoiceStatus.CREATED,
      new SignInvoiceCommand({ signInvoice: async (xml) => `${xml}<!-- signed -->` }, repo),
    ],
    [InvoiceStatus.SIGNED, new SendInvoiceCommand({ validateXml }, repo)],
    [InvoiceStatus.SENT, new AuthorizeInvoiceCommand({ authorizeXml }, repo, storage)],
  ]);
}

/** The access code in an invoice XML */
export const accessCodeOf = (xml: string) => /<claveAcceso>(\d{49})<\/claveAcceso>/.exec(xml)![1];

/**
 * A Kafka consumer that delivers what the test hands it, one message at a time like a partition,
 * and records the offsets committed
 */
export function fakeKafkaConsumer() {
  let eachMessage: KafkaJS.EachMessageHandler | undefined;
  const committed: string[] = [];
  let offset = 0;
  const consumer = {
    connect: async () => {},
    subscribe: async () => {},
    run: async (config: KafkaJS.ConsumerRunConfig) => {
      eachMessage = config.eachMessage;
    },
    commitOffsets: async (offsets: KafkaJS.TopicPartitionOffset[]) => {
      committed.push(...offsets.map((o) => o.offset));
    },
    disconnect: async () => {},
  } as unknown as KafkaJS.Consumer;
  const deliver = (topic: string, value: unknown, headers: Record<string, string> = {}) =>
    eachMessage!({
      topic,
      partition: 0,
      message: {
        key: null,
        value: Buffer.from(JSON.stringify(value)),
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, Buffer.from(v)])),
        offset: String(offset++),
        timestamp: '0',
      },
    } as unknown as KafkaJS.EachMessagePayload);
  return { consumer, deliver, committed };
}

/** Object storage kept in memory; `failing` makes every upload fail like an unreachable service */
export class InMemoryDocumentStorage implements DocumentStorage {
  readonly objects = new Map<string, { body: string | Buffer; contentType: string }>();
  failing = false;

  async put(key: string, body: string | Buffer, contentType: string): Promise<void> {
    this.failIfUnreachable();
    this.objects.set(key, { body, contentType });
  }

  async get(key: string): Promise<string | null> {
    return (await this.getBytes(key))?.toString('utf-8') ?? null;
  }

  async getBytes(key: string): Promise<Buffer | null> {
    const body = this.objects.get(key)?.body;
    if (body === undefined) return null;
    return typeof body === 'string' ? Buffer.from(body, 'utf-8') : body;
  }

  async delete(key: string): Promise<void> {
    this.failIfUnreachable();
    this.objects.delete(key);
  }

  private failIfUnreachable(): void {
    if (this.failing) {
      throw new InvoiceIssueError('STORAGE_UNAVAILABLE', 'Object storage failed: unreachable');
    }
  }
}

function toRow(invoice: Invoice): InvoiceRow {
  return {
    ...toInvoiceRow(invoice),
    status_history: toInvoiceEventRows(invoice).map((event) => ({
      status: event.status,
      occurred_at: event.occurred_at.toISOString(),
      description: event.description,
    })),
  };
}

const IN_FLIGHT = [
  InvoiceStatus.PENDING,
  InvoiceStatus.CREATED,
  InvoiceStatus.SIGNED,
  InvoiceStatus.SENT,
];

/**
 * Same contract as PgInvoiceRepository and PgInvoiceQueue (the same table), kept in memory through
 * the row mapper
 */
export class InMemoryInvoiceRepository implements InvoiceRepository, InvoiceQueue {
  readonly records = new Map<string, InvoiceRow>();
  // Last number issued by company, establishment and emission point
  readonly sequences = new Map<string, number>();
  // The queue's leases (locked_by, locked_until), by invoice
  readonly locks = new Map<string, { holder: string; until: number }>();
  // invoice_deliveries: saveAuthorized writes there too
  readonly deliveries: InMemoryDeliveryRepository;

  constructor(private readonly now: () => Date = () => new Date()) {
    this.deliveries = new InMemoryDeliveryRepository(now);
  }

  async createInvoice(invoice: Invoice): Promise<boolean> {
    if (this.records.has(invoice.id)) return false;
    // Like uq_invoices_active_sale
    const active = [...this.records.values()].some(
      (row) =>
        row.tenant_id === invoice.tenantId &&
        row.sale_id === invoice.saleId &&
        row.status !== InvoiceStatus.REJECTED,
    );
    if (active && invoice.isActive) return false;
    invoice.version += 1;
    this.records.set(invoice.id, toRow(invoice));
    return true;
  }

  async updateInvoice(invoice: Invoice): Promise<Invoice> {
    const stored = this.records.get(invoice.id);
    if (!stored || stored.version !== invoice.version) {
      throw new ConcurrentUpdateError(invoice.id);
    }
    invoice.version += 1;
    this.records.set(invoice.id, toRow(invoice));
    return invoice;
  }

  async saveAuthorized(invoice: Invoice, delivery: InvoiceDelivery): Promise<Invoice> {
    // Like one transaction: no delivery when the invoice can't be saved
    await this.updateInvoice(invoice);
    await this.deliveries.insert(delivery);
    return invoice;
  }

  async assignSequence(invoice: Invoice): Promise<Invoice> {
    const stored = this.records.get(invoice.id);
    if (!stored || stored.version !== invoice.version) {
      throw new ConcurrentUpdateError(invoice.id);
    }
    const { tenantId, establishment, emissionPoint } = invoice.point;
    const key = [tenantId, establishment, emissionPoint, INVOICE_DOC_TYPE].join('|');
    const next = (this.sequences.get(key) ?? 0) + 1;
    this.sequences.set(key, next);
    invoice.assignSequence(formatSequence(next));
    return this.updateInvoice(invoice);
  }

  async getInvoiceById(id: string): Promise<Invoice | null> {
    const row = this.records.get(id);
    return row ? fromInvoiceRow(structuredClone(row)) : null;
  }

  async findForTenant(tenantId: string, id: string): Promise<Invoice | null> {
    const invoice = await this.getInvoiceById(id);
    return invoice?.tenantId === tenantId ? invoice : null;
  }

  async findPage(tenantId: string, filter: InvoiceFilter, page: PageRequest): Promise<InvoicePage> {
    const matching = (await this.all())
      .filter((invoice) => invoice.tenantId === tenantId)
      .filter((invoice) => !filter.status || invoice.status === filter.status)
      .filter((invoice) => !filter.createdFrom || invoice.createdAt >= filter.createdFrom)
      .filter((invoice) => !filter.createdBefore || invoice.createdAt < filter.createdBefore)
      .filter((invoice) => !filter.attention || invoice.needsAttention)
      .sort((a, b) =>
        filter.attention
          ? b.updatedAt.getTime() - a.updatedAt.getTime()
          : b.createdAt.getTime() - a.createdAt.getTime(),
      );
    return {
      items: matching.slice(page.offset, page.offset + page.limit),
      total: matching.length,
    };
  }

  async findBySaleId(tenantId: string, saleId: string): Promise<Invoice[]> {
    return (await this.all()).filter(
      (invoice) => invoice.tenantId === tenantId && invoice.saleId === saleId,
    );
  }

  async countInFlight(tenantId: string): Promise<InFlightCounts> {
    const inFlight = (await this.all()).filter(
      (invoice) => !invoice.isFinal && invoice.tenantId === tenantId,
    );
    return {
      total: inFlight.length,
      withIssues: inFlight.filter((invoice) => invoice.issue !== null).length,
      needingAttention: inFlight.filter((invoice) => invoice.needsAttention).length,
    };
  }

  async claimDue(holder: string, leaseMs: number, limit: number): Promise<ClaimedInvoice[]> {
    const now = this.now().getTime();
    const due = [...this.records.values()]
      .filter((row) => row.next_attempt_at !== null && row.next_attempt_at.getTime() <= now)
      .filter((row) => this.isFree(row.id, now))
      .sort((a, b) => a.next_attempt_at!.getTime() - b.next_attempt_at!.getTime())
      .slice(0, limit);
    for (const row of due) this.locks.set(row.id, { holder, until: now + leaseMs });
    return due.map((row) => ({ id: row.id, traceContext: row.trace_context }));
  }

  async claim(id: string, holder: string, leaseMs: number): Promise<boolean> {
    const now = this.now().getTime();
    if (!this.records.has(id) || !this.isFree(id, now)) return false;
    this.locks.set(id, { holder, until: now + leaseMs });
    return true;
  }

  async renew(id: string, holder: string, leaseMs: number): Promise<boolean> {
    if (this.locks.get(id)?.holder !== holder) return false;
    this.locks.set(id, { holder, until: this.now().getTime() + leaseMs });
    return true;
  }

  async release(id: string, holder: string): Promise<void> {
    if (this.locks.get(id)?.holder === holder) this.locks.delete(id);
  }

  async postpone(id: string, at: Date): Promise<void> {
    const row = this.records.get(id);
    if (row) row.next_attempt_at = at;
  }

  async findWaiting(tenantId?: string): Promise<WaitingInvoice[]> {
    const now = this.now().getTime();
    return [...this.records.values()]
      .filter((row) => IN_FLIGHT.includes(row.status as InvoiceStatus))
      .filter((row) => row.next_attempt_at === null || row.next_attempt_at.getTime() > now)
      .filter((row) => tenantId === undefined || row.tenant_id === tenantId)
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
      .map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        issuerRuc: row.issuer_ruc,
        issueCode: row.issue_code as WaitingInvoice['issueCode'],
        nextAttemptAt: row.next_attempt_at,
      }));
  }

  async requeue(ids: string[], at: Date): Promise<number> {
    let changed = 0;
    for (const id of ids) {
      const row = this.records.get(id);
      if (!row || !IN_FLIGHT.includes(row.status as InvoiceStatus)) continue;
      if (row.next_attempt_at !== null && row.next_attempt_at <= at) continue;
      row.next_attempt_at = at;
      changed += 1;
    }
    return changed;
  }

  private isFree(id: string, now: number): boolean {
    const lock = this.locks.get(id);
    return !lock || lock.until < now;
  }

  private async all(): Promise<Invoice[]> {
    return [...this.records.values()].map((row) => fromInvoiceRow(structuredClone(row)));
  }
}

const copyOf = (delivery: InvoiceDelivery) => new InvoiceDelivery({ ...delivery });

/** Same contract as PgInvoiceDeliveryRepository (deliveries and their queue), kept in memory */
export class InMemoryDeliveryRepository implements InvoiceDeliveryRepository, DeliveryQueue {
  readonly records = new Map<string, InvoiceDelivery>();
  readonly locks = new Map<string, { holder: string; until: number }>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Like insertDelivery: false when a unique index of invoice_deliveries forbids it */
  async insert(delivery: InvoiceDelivery): Promise<boolean> {
    const clash = [...this.records.values()].some(
      (stored) =>
        stored.invoiceId === delivery.invoiceId &&
        ((stored.kind === 'authorization' && delivery.kind === 'authorization') ||
          (stored.isPending && delivery.isPending)),
    );
    if (clash || this.records.has(delivery.id)) return false;
    this.records.set(delivery.id, copyOf(delivery));
    return true;
  }

  async getById(id: string): Promise<InvoiceDelivery | null> {
    const delivery = this.records.get(id);
    return delivery ? copyOf(delivery) : null;
  }

  async update(delivery: InvoiceDelivery): Promise<void> {
    if (this.records.has(delivery.id)) this.records.set(delivery.id, copyOf(delivery));
  }

  async createResend(delivery: InvoiceDelivery): Promise<InvoiceDelivery> {
    if (await this.insert(delivery)) return delivery;
    const pending = [...this.records.values()].find(
      (stored) =>
        stored.tenantId === delivery.tenantId &&
        stored.invoiceId === delivery.invoiceId &&
        stored.isPending,
    );
    if (!pending) throw new Error('No pending delivery');
    return copyOf(pending);
  }

  async findByInvoice(tenantId: string, invoiceId: string): Promise<InvoiceDelivery[]> {
    return [...this.records.values()]
      .filter((stored) => stored.tenantId === tenantId && stored.invoiceId === invoiceId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(copyOf);
  }

  async claimDue(holder: string, leaseMs: number, limit: number): Promise<ClaimedDelivery[]> {
    const now = this.now().getTime();
    const due = [...this.records.values()]
      .filter((stored) => stored.isPending && stored.nextAttemptAt!.getTime() <= now)
      .filter((stored) => {
        const lock = this.locks.get(stored.id);
        return !lock || lock.until < now;
      })
      .sort((a, b) => a.nextAttemptAt!.getTime() - b.nextAttemptAt!.getTime())
      .slice(0, limit);
    for (const stored of due) this.locks.set(stored.id, { holder, until: now + leaseMs });
    return due.map((stored) => ({
      id: stored.id,
      invoiceId: stored.invoiceId,
      traceContext: stored.traceContext,
    }));
  }

  async release(id: string, holder: string): Promise<void> {
    if (this.locks.get(id)?.holder === holder) this.locks.delete(id);
  }

  async postpone(id: string, at: Date): Promise<void> {
    const stored = this.records.get(id);
    if (stored?.isPending) stored.nextAttemptAt = at;
  }
}

/** Same contract as PgCompanyConfigRepository: one profile per company, which keeps its logo */
export class InMemoryCompanyConfigRepository implements CompanyConfigRepository {
  readonly configs = new Map<string, CompanyConfig>();

  async save(config: CompanyConfig): Promise<CompanyConfig> {
    const stored = withLogo(config, this.configs.get(config.tenantId)?.logo ?? null);
    this.configs.set(config.tenantId, stored);
    return stored;
  }

  async find(tenantId: string): Promise<CompanyConfig | null> {
    return this.configs.get(tenantId) ?? null;
  }

  async setLogo(tenantId: string, logo: IssuerLogo): Promise<CompanyConfig | null> {
    const config = this.configs.get(tenantId);
    if (!config) return null;
    const stored = withLogo(config, logo);
    this.configs.set(tenantId, stored);
    return stored;
  }

  async clearLogo(tenantId: string): Promise<boolean> {
    const config = this.configs.get(tenantId);
    if (!config?.logo) return false;
    this.configs.set(tenantId, withLogo(config, null));
    return true;
  }
}

function withLogo(config: CompanyConfig, logo: IssuerLogo | null): CompanyConfig {
  return new CompanyConfig(
    config.tenantId,
    config.taxId,
    config.name,
    config.tradeName,
    config.mainAddress,
    config.specialTaxpayerResolution,
    config.withholdingAgentResolution,
    config.rimpeRegime,
    config.accountingRequired,
    config.environment,
    config.emissionType,
    config.signingCertId,
    config.updatedAt,
    config.email,
    logo,
  );
}

/** Same contract as PgCertificateRepository: another company's certificate is not found */
export class InMemoryCertificateRepository implements CertificateRepository {
  readonly certificates = new Map<string, Certificate>();

  async save(certificate: Certificate): Promise<Certificate> {
    this.certificates.set(certificate.id, certificate);
    return certificate;
  }

  async findById(tenantId: string, id: string): Promise<Certificate | null> {
    const certificate = this.certificates.get(id);
    return certificate?.tenantId === tenantId ? certificate : null;
  }

  async findAll(tenantId: string): Promise<Certificate[]> {
    return [...this.certificates.values()].filter((cert) => cert.tenantId === tenantId);
  }

  async delete(tenantId: string, id: string): Promise<void> {
    if (await this.findById(tenantId, id)) this.certificates.delete(id);
  }
}

/** Same contract as PgSequenceRepository */
export class InMemorySequenceRepository implements SequenceRepository {
  readonly sequences = new Map<string, Sequence>();

  async findAll(tenantId: string): Promise<Sequence[]> {
    return [...this.sequences.values()].filter((sequence) => sequence.tenantId === tenantId);
  }

  async find(key: SequenceKey): Promise<Sequence | null> {
    return this.sequences.get(sequenceId(key)) ?? null;
  }

  async setNext(key: SequenceKey, next: number): Promise<Sequence | null> {
    const current = await this.find(key);
    if (current && current.lastValue > next - 1) return null;
    const sequence = { ...key, lastValue: next - 1 };
    this.sequences.set(sequenceId(key), sequence);
    return sequence;
  }
}

const sequenceId = (key: SequenceKey) =>
  [key.tenantId, key.establishment, key.emissionPoint, key.docType].join('|');

export function makeSale(overrides: Partial<SaleData> = {}): SaleData {
  return {
    sale_id: 42,
    source: 'pos',
    subtotal: '10.00',
    total_discount: '0.00',
    total: '11.50',
    customer: null,
    items: [
      {
        product_id: 7,
        sku: 'SKU-7',
        product_name: 'Producto',
        quantity: 1,
        unit_price: '10.00',
        discount: '0',
        tax_code: 'VAT_15',
        tax_amount: '1.50',
        subtotal: '10.00',
        invoice_discount: '0.00',
        invoice_base: '10.00',
        invoice_tax: '1.50',
      },
    ],
    payments: [{ method: 'CASH', amount: '11.50' }],
    ...overrides,
  };
}

/** Company A's establishment 001 and emission point 001, unless overridden */
export function makePoint(overrides: Partial<IssuingPoint> = {}): IssuingPoint {
  return {
    tenantId: TENANT_A,
    issuerRuc: RUC_A,
    establishment: '001',
    emissionPoint: '001',
    establishmentAddress: 'Av. Amazonas N34-120, Quito',
    ...overrides,
  };
}

/** The sales.confirmed v2 message of a sale made at `point` */
export function makeSaleMessage(
  eventId: string,
  sale: SaleData = makeSale(),
  point: IssuingPoint = makePoint(),
): SaleConfirmedV2Message {
  return {
    event_id: eventId,
    event_type: 'SaleConfirmed',
    schema_version: 2,
    tenant_id: point.tenantId,
    aggregate_id: sale.sale_id,
    occurred_at: REQUESTED_AT,
    payload: {
      ...sale,
      sale_number: null,
      issuer_ruc: point.issuerRuc ?? RUC_A,
      establishment_code: point.establishment,
      establishment_address: point.establishmentAddress,
      emission_point_code: point.emissionPoint,
    },
  };
}

/** A sale received for invoicing, as SaleConfirmedHandler hands it to ReceiveSaleCommand */
export function makeReceivedSale(
  eventId: string,
  sale: SaleData = makeSale(),
  point: IssuingPoint = makePoint(),
): ReceivedSale {
  return { eventId, point, sale, requestedAt: REQUESTED_AT };
}

// An access code of 2026 in testing, for invoices that don't go through PrepareInvoiceCommand
export const TEST_ACCESS_CODE = '0910202601179214100100110010010000000011234567812';

// When the simulated SRI authorizes, and what it answers
export const TEST_AUTHORIZATION = {
  number: TEST_ACCESS_CODE,
  authorizedAt: new Date('2026-10-09T15:01:02Z'),
};

/**
 * The input of an invoice with every part the RIDE prints: the issuer's legends, a customer with
 * contact data, lines at 15%, 0% and not taxed (one with a discount), two payments and the
 * provider's RUC. Totals: 80.75 + 8.64 + 5.00 without taxes, 12.11 of IVA, 106.50
 */
export function fullInvoiceXmlInput(overrides: Partial<InvoiceXmlInput> = {}): InvoiceXmlInput {
  return {
    environment: 1,
    emissionType: 1,
    companyName: 'Ferretería ACME S.A.',
    companyTradeName: 'ACME',
    companyCode: RUC_A,
    companyMainAddress: 'Av. 10 de Agosto N25-34, Quito',
    companyBranchAddress: 'Av. Amazonas N34-120, Quito',
    companyBranchCode: '001',
    companySalePointCode: '001',
    companyAccountingRequired: true,
    companySpecialTaxpayerResolution: '5368',
    companyWithholdingAgentResolution: '12345678',
    companyRimpeRegime: RimpeRegime.ENTREPRENEUR,
    providerRuc: RUC_B,
    accessCode: TEST_ACCESS_CODE,
    sequence: '000000001',
    voucherTypeCode: '01',
    date: REQUESTED_AT,
    customer: {
      taxIdCode: '04',
      name: 'Construcciones Andinas Cía. Ltda.',
      taxId: '1790012345001',
      email: 'compras@construccionesandinas.ec',
      phone: '022345678',
      address: 'Av. 6 de Diciembre N24-253, Quito',
    },
    total: 106.5,
    payments: [
      { formaPago: '01', amount: 50 },
      { formaPago: '19', amount: 56.5 },
    ],
    items: [
      {
        productId: '7',
        sku: 'CEM-50',
        description: 'Cemento Portland 50 kg',
        quantity: 10,
        unitPrice: 8.5,
        discount: 4.25,
        taxableBase: 80.75,
        taxCode: 4,
        taxRate: 15,
        taxAmount: 12.11,
      },
      {
        productId: '8',
        sku: 'VAR-12',
        description: 'Varilla corrugada 12 mm',
        quantity: 2.5,
        unitPrice: 3.456789,
        discount: 0,
        taxableBase: 8.64,
        taxCode: 0,
        taxRate: 0,
        taxAmount: 0,
      },
      {
        productId: '9',
        sku: null,
        description: 'Corte de varilla',
        quantity: 1,
        unitPrice: 5,
        discount: 0,
        taxableBase: 5,
        taxCode: 6,
        taxRate: 0,
        taxAmount: 0,
      },
    ],
    ...overrides,
  };
}

/** fullInvoiceXmlInput's XML, signed like the test signer does */
export function signedInvoiceXml(overrides: Partial<InvoiceXmlInput> = {}): string {
  return `${buildInvoiceXml(fullInvoiceXmlInput(overrides))}<!-- signed -->`;
}

/**
 * An invoice the SRI authorized, with its authorized XML in `storage` (left out when null, like
 * an invoice authorized before S4.1)
 */
export async function makeAuthorizedInvoice(
  id: string,
  point: IssuingPoint,
  storage: DocumentStorage | null,
  sale: SaleData = makeSale(),
): Promise<Invoice> {
  const invoice = Invoice.receive(id, point, sale);
  invoice.assignSequence('000000001');
  const accessCode = AccessCode.create(TEST_ACCESS_CODE);
  const xml = signedInvoiceXml({
    companyCode: point.issuerRuc ?? RUC_A,
    companyBranchCode: point.establishment,
    companySalePointCode: point.emissionPoint,
  });
  invoice.prepare({ accessCode, signatureId: 'cert-1', xml });
  invoice.sign(xml);
  invoice.markAsSent([]);
  const xmlKey = authorizedXmlKey(point.tenantId, accessCode.emissionYear, accessCode.value);
  invoice.authorize({ ...TEST_AUTHORIZATION, xmlKey }, ['AUTORIZADO']);
  if (storage) {
    await storage.put(xmlKey, `<autorizacion><estado>AUTORIZADO</estado></autorizacion>`, 'xml');
  }
  return invoice;
}

/** Company A's fiscal profile, unless overridden */
export function makeConfig(overrides: Partial<Parameters<typeof CompanyConfig.create>[0]> = {}) {
  return CompanyConfig.create({
    tenantId: TENANT_A,
    taxId: RUC_A,
    name: 'ACME S.A.',
    tradeName: 'ACME',
    mainAddress: 'Quito',
    environment: Environment.PRODUCTION,
    emissionType: EmissionType.NORMAL,
    signingCertId: 'cert-1',
    ...overrides,
  });
}

export function makeCertificate(
  overrides: {
    id?: string;
    tenantId?: string;
    taxIds?: string[];
    validTo?: Date;
    p12Ciphertext?: string;
    passwordCiphertext?: string | null;
  } = {},
): Certificate {
  return new Certificate(
    overrides.id ?? 'cert-1',
    overrides.tenantId ?? TENANT_A,
    '123',
    'CN=ACME',
    'CN=CA',
    overrides.taxIds ?? [RUC_A],
    new Date('2025-01-01T00:00:00Z'),
    overrides.validTo ?? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    'acme.p12',
    overrides.p12Ciphertext ?? 'v1:p12',
    new Date('2025-01-01T00:00:00Z'),
    overrides.passwordCiphertext === undefined ? 'v1:secret' : overrides.passwordCiphertext,
  );
}

type IssuerState = ReadyIssuer | IssuerNotReadyError;

/**
 * Readiness that answers with `issuer` for every company, or by company with a record (a company
 * missing from it has no config)
 */
export function readinessStub(issuer: IssuerState | Record<string, IssuerState>) {
  const stateOf = (tenantId: string): IssuerState => {
    if (issuer instanceof Error || 'config' in issuer) return issuer as IssuerState;
    return (
      (issuer as Record<string, IssuerState>)[tenantId] ??
      new IssuerNotReadyError('CONFIG_MISSING', 'The company fiscal config has not been saved')
    );
  };
  return {
    check: vi.fn(async (tenantId: string): Promise<ReadinessReport> => {
      const state = stateOf(tenantId);
      const ready = !(state instanceof Error);
      return {
        ready,
        taxId: ready ? state.config.taxId : null,
        environment: null,
        certificate: null,
        issues: [],
      };
    }),
    requireReady: vi.fn(async (tenantId: string) => {
      const state = stateOf(tenantId);
      if (state instanceof Error) throw state;
      return state;
    }),
    invalidate: vi.fn(),
    invalidateIfOlder: vi.fn(),
  } as unknown as IssuerReadinessService;
}

/** A multipart/form-data body with one file in the field `file`, for `app.inject` */
export function multipartFile(
  bytes: Buffer,
  filename = 'logo.png',
  contentType = 'image/png',
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----faclab-test';
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          `Content-Type: ${contentType}\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/** Lets every request through as a user of `tenantId`, like a valid token of that company */
export function authorizeAs(tenantId: string = TENANT_A): Authorize {
  return () => async (request) => {
    request.auth = { userId: '1', username: 'admin', tenantId, permissions: [] };
  };
}
