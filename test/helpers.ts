import { vi } from 'vitest';

import { Certificate } from '#/modules/certificate/domain/certificate';
import { CertificateRepository } from '#/modules/certificate/domain/repository';
import { IssuerReadinessService, ReadyIssuer } from '#/modules/company-config/app/issuer-readiness';
import {
  CompanyConfig,
  EmissionType,
  Environment,
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
import { ReceivedSale } from '#/modules/invoice/app/commands/receive-sale';
import { Invoice, InvoiceStatus } from '#/modules/invoice/domain/invoice';
import {
  ConcurrentUpdateError,
  InFlightCounts,
  InvoiceFilter,
  InvoicePage,
  InvoiceRepository,
  PageRequest,
} from '#/modules/invoice/domain/repository';
import { IssuingPoint, SaleData } from '#/modules/invoice/domain/sale';
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

/** Same contract as PgInvoiceRepository, kept in memory through the row mapper */
export class InMemoryInvoiceRepository implements InvoiceRepository {
  readonly records = new Map<string, InvoiceRow>();
  // Last number issued by company, establishment and emission point
  readonly sequences = new Map<string, number>();

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

  async findInFlight(): Promise<Invoice[]> {
    return (await this.all()).filter((invoice) => !invoice.isFinal);
  }

  async countInFlight(tenantId: string): Promise<InFlightCounts> {
    const inFlight = (await this.findInFlight()).filter((invoice) => invoice.tenantId === tenantId);
    return {
      total: inFlight.length,
      withIssues: inFlight.filter((invoice) => invoice.issue !== null).length,
      needingAttention: inFlight.filter((invoice) => invoice.needsAttention).length,
    };
  }

  private async all(): Promise<Invoice[]> {
    return [...this.records.values()].map((row) => fromInvoiceRow(structuredClone(row)));
  }
}

/** Same contract as PgCompanyConfigRepository: one profile per company */
export class InMemoryCompanyConfigRepository implements CompanyConfigRepository {
  readonly configs = new Map<string, CompanyConfig>();

  async save(config: CompanyConfig): Promise<CompanyConfig> {
    this.configs.set(config.tenantId, config);
    return config;
  }

  async find(tenantId: string): Promise<CompanyConfig | null> {
    return this.configs.get(tenantId) ?? null;
  }
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
    occurred_at: new Date('2026-10-09T15:00:00Z'),
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
  return { eventId, point, sale };
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
  } as unknown as IssuerReadinessService;
}

/** Lets every request through as a user of `tenantId`, like a valid token of that company */
export function authorizeAs(tenantId: string = TENANT_A): Authorize {
  return () => async (request) => {
    request.auth = { userId: '1', username: 'admin', tenantId, permissions: [] };
  };
}
