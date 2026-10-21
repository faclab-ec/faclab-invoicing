import { vi } from 'vitest';

import { Certificate } from '#/modules/certificate/domain/certificate';
import { IssuerReadinessService, ReadyIssuer } from '#/modules/company-config/app/issuer-readiness';
import {
  CompanyConfig,
  EmissionType,
  Environment,
} from '#/modules/company-config/domain/company-config';
import { IssuerNotReadyError } from '#/modules/company-config/domain/readiness';
import { CompanyConfigRepository } from '#/modules/company-config/domain/repository';
import { Invoice, InvoiceStatus } from '#/modules/invoice/domain/invoice';
import {
  ConcurrentUpdateError,
  InvoiceFilter,
  InvoicePage,
  InvoiceRepository,
  PageRequest,
} from '#/modules/invoice/domain/repository';
import { SaleData } from '#/modules/invoice/domain/sale';
import { SaleConfirmedMessage } from '#/modules/invoice/infra/messaging/schemas';
import {
  fromInvoiceRow,
  InvoiceRow,
  toInvoiceEventRows,
  toInvoiceRow,
} from '#/modules/invoice/infra/persistence/invoice.mapper';

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

  async createInvoice(invoice: Invoice): Promise<boolean> {
    if (this.records.has(invoice.id)) return false;
    // Like uq_invoices_active_sale
    const active = [...this.records.values()].some(
      (row) => row.sale_id === invoice.saleId && row.status !== InvoiceStatus.REJECTED,
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

  async getInvoiceById(id: string): Promise<Invoice | null> {
    const row = this.records.get(id);
    return row ? fromInvoiceRow(structuredClone(row)) : null;
  }

  async findPage(filter: InvoiceFilter, page: PageRequest): Promise<InvoicePage> {
    const matching = (await this.all())
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

  async findBySaleId(saleId: string): Promise<Invoice[]> {
    return (await this.all()).filter((invoice) => invoice.saleId === saleId);
  }

  async findInFlight(): Promise<Invoice[]> {
    return (await this.all()).filter((invoice) => !invoice.isFinal);
  }

  private async all(): Promise<Invoice[]> {
    return [...this.records.values()].map((row) => fromInvoiceRow(structuredClone(row)));
  }
}

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

export function makeSaleMessage(
  eventId: string,
  sale: SaleData = makeSale(),
): SaleConfirmedMessage {
  return {
    event_id: eventId,
    event_type: 'SaleConfirmed',
    aggregate_id: sale.sale_id,
    occurred_at: new Date('2026-10-09T15:00:00Z'),
    payload: sale,
  };
}

export function makeConfig(overrides: Partial<Parameters<typeof CompanyConfig.create>[0]> = {}) {
  return CompanyConfig.create({
    taxId: '1792141001001',
    name: 'ACME S.A.',
    tradeName: 'ACME',
    mainAddress: 'Quito',
    branchAddress: 'Quito',
    branchCode: '001',
    salePointCode: '001',
    environment: Environment.PRODUCTION,
    emissionType: EmissionType.NORMAL,
    signingCertId: 'cert-1',
    ...overrides,
  });
}

export function makeCertificate(
  overrides: {
    id?: string;
    validTo?: Date;
    p12Ciphertext?: string;
    passwordCiphertext?: string | null;
  } = {},
): Certificate {
  return new Certificate(
    overrides.id ?? 'cert-1',
    '123',
    'CN=ACME',
    'CN=CA',
    new Date('2025-01-01T00:00:00Z'),
    overrides.validTo ?? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    'acme.p12',
    overrides.p12Ciphertext ?? 'v1:p12',
    new Date('2025-01-01T00:00:00Z'),
    overrides.passwordCiphertext === undefined ? 'v1:secret' : overrides.passwordCiphertext,
  );
}

export function readinessStub(issuer: ReadyIssuer | IssuerNotReadyError) {
  return {
    check: vi.fn(async () => ({
      ready: !(issuer instanceof Error),
      environment: null,
      certificate: null,
      issues: [],
    })),
    requireReady: vi.fn(async () => {
      if (issuer instanceof Error) throw issuer;
      return issuer;
    }),
    invalidate: vi.fn(),
  } as unknown as IssuerReadinessService;
}

export function configRepoStub(): CompanyConfigRepository {
  let sequence = 0;
  return {
    save: vi.fn(),
    find: vi.fn(),
    nextInvoiceSequence: vi.fn(async () => ++sequence),
    setNextInvoiceSequence: vi.fn(async (next: number) => {
      sequence = next - 1;
    }),
  };
}
