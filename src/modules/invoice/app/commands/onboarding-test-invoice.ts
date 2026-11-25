import { randomUUID } from 'node:crypto';

import { IssuerReadinessService } from '#/modules/company-config/app/issuer-readiness';
import { Environment } from '#/modules/company-config/domain/company-config';
import { CompanyConfigRepository } from '#/modules/company-config/domain/repository';
import { ConflictError } from '#/shared/errors/app-error';

import { Invoice } from '../../domain/invoice';
import { InvoiceRepository } from '../../domain/repository';
import { ONBOARDING_SALE_SOURCE, SaleData } from '../../domain/sale';
import { ReceiveSaleCommand } from './receive-sale';

export interface TestInvoiceInput {
  establishment?: string;
  emissionPoint?: string;
}

// A cent: an invoice to the final consumer of the lowest amount the SRI takes
const TEST_AMOUNT = '0.01';

/**
 * A test invoice of the onboarding (S8.5): a sale of one cent to the final consumer, from the
 * company's first emission point, that goes through the whole pipeline (sign, send, authorize)
 * against the SRI's test environment. It proves the certificate, the profile and the connection
 * before going to production. It isn't a sale of faclab-core: its result isn't published and it is
 * forgotten when the company goes to production.
 */
export class SubmitTestInvoiceCommand {
  constructor(
    private readonly configRepository: CompanyConfigRepository,
    private readonly readiness: IssuerReadinessService,
    private readonly receiveSale: ReceiveSaleCommand,
    private readonly invoices: InvoiceRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly newEventId: () => string = randomUUID,
  ) {}

  async execute(tenantId: string, input: TestInvoiceInput = {}): Promise<Invoice> {
    const config = await this.configRepository.find(tenantId);
    if (!config) {
      throw new ConflictError('ISSUER_NOT_CONFIGURED', 'Save the fiscal profile first');
    }
    if (config.environment !== Environment.TESTING) {
      throw new ConflictError(
        'TEST_INVOICE_ONLY_IN_TESTING',
        'A test invoice is only issued in the SRI test environment',
      );
    }
    const report = await this.readiness.check(tenantId);
    const blocking = report.issues.find((issue) => issue.severity === 'error');
    if (!report.ready || blocking) {
      throw new ConflictError(
        'ISSUER_NOT_READY',
        blocking?.message ?? 'The issuer is not ready to invoice',
      );
    }

    // One at a time, and one that was authorized is enough
    const last = await this.invoices.findOnboardingTest(tenantId);
    if (last?.isActive) return last;

    const now = this.now();
    const invoice = await this.receiveSale.execute({
      eventId: this.newEventId(),
      requestedAt: now,
      point: {
        tenantId,
        issuerRuc: config.taxId,
        establishment: input.establishment ?? '001',
        emissionPoint: input.emissionPoint ?? '001',
        establishmentAddress: config.mainAddress,
        branchId: null,
      },
      sale: testSale(now),
    });
    if (!invoice) {
      throw new ConflictError('TEST_INVOICE_NOT_CREATED', 'The test invoice could not be created');
    }
    return invoice;
  }
}

export class GetTestInvoiceQuery {
  constructor(private readonly invoices: InvoiceRepository) {}

  async execute(tenantId: string): Promise<Invoice | null> {
    return this.invoices.findOnboardingTest(tenantId);
  }
}

/** A sale id that no real one has: faclab-core's are positive */
function testSale(now: Date): SaleData {
  return {
    sale_id: -Math.floor(now.getTime() / 1000),
    source: ONBOARDING_SALE_SOURCE,
    subtotal: TEST_AMOUNT,
    total_discount: '0.00',
    total: TEST_AMOUNT,
    customer: null,
    items: [
      {
        product_id: 0,
        sku: 'PRUEBA',
        product_name: 'Factura de prueba del onboarding',
        quantity: '1',
        unit_price: TEST_AMOUNT,
        discount: '0.00',
        tax_code: 'VAT_0',
        tax_amount: '0.00',
        subtotal: TEST_AMOUNT,
        invoice_discount: '0.00',
        invoice_base: TEST_AMOUNT,
        invoice_tax: '0.00',
      },
    ],
    payments: [{ method: 'CASH', amount: TEST_AMOUNT }],
  };
}
