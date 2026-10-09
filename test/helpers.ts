import { Certificate } from '#/modules/certificate/domain/certificate';
import {
  CompanyConfig,
  EmissionType,
  Environment,
} from '#/modules/company-config/domain/company-config';
import { Invoice } from '#/modules/invoice/domain/invoice';
import { ConcurrentUpdateError, InvoiceRepository } from '#/modules/invoice/domain/repository';
import { SaleData } from '#/modules/invoice/domain/sale';
import { SaleConfirmedMessage } from '#/modules/invoice/infra/messaging/schemas';
import {
  fromInvoiceRecord,
  InvoiceRecord,
  toInvoiceRecord,
} from '#/modules/invoice/infra/persistence/invoice.mapper';

/** Same contract as DynamoInvoiceRepository, kept in memory through the record mapper */
export class InMemoryInvoiceRepository implements InvoiceRepository {
  readonly records = new Map<string, InvoiceRecord>();

  async createInvoice(invoice: Invoice): Promise<boolean> {
    if (this.records.has(invoice.id)) return false;
    invoice.version += 1;
    this.records.set(invoice.id, toInvoiceRecord(invoice));
    return true;
  }

  async updateInvoice(invoice: Invoice): Promise<Invoice> {
    const stored = this.records.get(invoice.id);
    if ((stored?.version ?? 0) !== invoice.version) throw new ConcurrentUpdateError(invoice.id);
    invoice.version += 1;
    this.records.set(invoice.id, toInvoiceRecord(invoice));
    return invoice;
  }

  async getInvoiceById(id: string): Promise<Invoice | null> {
    const record = this.records.get(id);
    return record ? fromInvoiceRecord(structuredClone(record)) : null;
  }

  async findAll(): Promise<Invoice[]> {
    return [...this.records.values()].map((r) => fromInvoiceRecord(structuredClone(r)));
  }

  async findBySaleId(saleId: string): Promise<Invoice[]> {
    return (await this.findAll()).filter((invoice) => invoice.saleId === saleId);
  }

  async findInFlight(): Promise<Invoice[]> {
    return (await this.findAll()).filter((invoice) => !invoice.isFinal);
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
  overrides: { id?: string; validTo?: Date; passwordCiphertext?: string | null } = {},
): Certificate {
  return new Certificate(
    overrides.id ?? 'cert-1',
    '123',
    'CN=ACME',
    'CN=CA',
    new Date('2025-01-01T00:00:00Z'),
    overrides.validTo ?? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    'acme.p12',
    'certificates/123/acme.p12',
    'http://s3/acme.p12',
    new Date('2025-01-01T00:00:00Z'),
    overrides.passwordCiphertext === undefined ? 'v1:secret' : overrides.passwordCiphertext,
  );
}
