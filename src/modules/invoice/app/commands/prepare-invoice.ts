import { IssuerReadinessService } from '#/modules/company-config/app/issuer-readiness';
import { IssuerNotReadyError } from '#/modules/company-config/domain/readiness';
import { logger } from '#/shared/logger';

import { AccessCode } from '../../domain/access-code';
import { generateAccessCode } from '../../domain/access-code-generator';
import { Invoice } from '../../domain/invoice';
import { buildInvoiceXml } from '../../domain/invoice-xml-builder';
import { InvoiceInvalidError } from '../../domain/issue';
import { InvoiceSchemaValidator } from '../../domain/ports';
import { InvoiceRepository } from '../../domain/repository';
import { SaleData } from '../../domain/sale';
import {
  FINAL_CONSUMER,
  IVA_CODES,
  PAYMENT_METHOD_CODES,
  TAX_TYPE_CODES,
} from '../../domain/sri-catalogs';
import { InvoiceCommand } from './command';

const VOUCHER_TYPE_CODE = '01';

// Schema errors shown in the invoice's issue
const MAX_SCHEMA_ERRORS = 5;

/**
 * Which date an invoice carries (D-4): `sale`, when faclab-core asked to invoice the sale (its
 * confirmation, or the resend), as immediate transmission asks since 2026; `prepared`, when its XML
 * is built, so an invoice that waited isn't late. Invoices received before S4.1 have no request
 * date and use the second.
 */
export type EmissionDateRule = 'sale' | 'prepared';

export interface PrepareInvoiceOptions {
  emissionDate: EmissionDateRule;
  // Highest total of an invoice to the final consumer, in USD (ficha técnica, 9.10: 50)
  finalConsumerMaxTotal: number;
  // RUC of the invoicing system's provider (Anexo 26); null leaves the field out
  providerRuc: string | null;
}

const toCents = (amount: string | number): number => Math.round(Number(amount) * 100);

const formatUsd = (cents: number): string => (cents / 100).toFixed(2);

/**
 * Builds the XML of a `pending` invoice with its company's issuer, from the establishment and
 * emission point of its sale. Waits (IssuerNotReadyError) until that issuer has a valid config and
 * a usable certificate, and while the sale names another RUC. A sale to the final consumer over
 * the limit is rejected without a number; an XML outside the SRI schema stays here with an issue
 * that is only retried by hand.
 */
export class PrepareInvoiceCommand implements InvoiceCommand {
  constructor(
    private readiness: IssuerReadinessService,
    private invoiceRepository: InvoiceRepository,
    private schemaValidator: InvoiceSchemaValidator,
    private options: PrepareInvoiceOptions,
    private now: () => Date = () => new Date(),
  ) {}

  async execute(invoice: Invoice): Promise<void> {
    const sale = invoice.sale;
    if (!sale) throw new Error(`Invoice ${invoice.id} has no sale data`);

    const overLimit = this.finalConsumerOverLimit(sale);
    if (overLimit) {
      invoice.reject([overLimit]);
      await this.invoiceRepository.updateInvoice(invoice);
      logger.warn({ invoiceId: invoice.id, saleId: invoice.saleId }, overLimit);
      return;
    }
    assertPaymentsMatchTotal(sale);

    const { point } = invoice;
    const { config, certificate } = await this.readiness.requireReady(point.tenantId);
    if (point.issuerRuc !== null && point.issuerRuc !== config.taxId) {
      throw new IssuerNotReadyError(
        'ISSUER_RUC_MISMATCH',
        `The sale was made by the RUC ${point.issuerRuc}, but the company's fiscal profile has ${config.taxId}`,
      );
    }

    // Saved before building the XML so a failed attempt doesn't burn another number; the numeric
    // code of the access code is assigned with it
    if (invoice.sequence === null) {
      await this.invoiceRepository.assignSequence(invoice);
    }
    const sequence = invoice.sequence!;

    const issuedAt = this.issuedAt(invoice);
    const accessCode = AccessCode.create(
      generateAccessCode({
        date: issuedAt,
        taxId: config.taxId,
        environment: config.environment,
        establishment: point.establishment,
        emissionPoint: point.emissionPoint,
        sequence,
        numericCode: invoice.requireNumericCode(),
      }),
    );

    const customer = sale.customer
      ? {
          taxIdCode: TAX_TYPE_CODES[sale.customer.tax_type] ?? FINAL_CONSUMER.taxIdCode,
          name: sale.customer.name,
          taxId: sale.customer.tax_id,
          email: sale.customer.email,
          phone: sale.customer.phone,
          address: sale.customer.address,
        }
      : { ...FINAL_CONSUMER };

    const xml = buildInvoiceXml({
      environment: config.environment,
      emissionType: config.emissionType,
      companyName: config.name,
      companyTradeName: config.tradeName,
      companyCode: config.taxId,
      companyMainAddress: config.mainAddress,
      companyBranchAddress: point.establishmentAddress,
      companyBranchCode: point.establishment,
      companySalePointCode: point.emissionPoint,
      companyAccountingRequired: config.accountingRequired,
      companySpecialTaxpayerResolution: config.specialTaxpayerResolution,
      companyWithholdingAgentResolution: config.withholdingAgentResolution,
      companyRimpeRegime: config.rimpeRegime,
      providerRuc: this.options.providerRuc,
      accessCode: accessCode.value,
      sequence,
      voucherTypeCode: VOUCHER_TYPE_CODE,
      date: issuedAt,
      customer,
      total: parseFloat(sale.total),
      payments: sale.payments.map((p) => ({
        formaPago: PAYMENT_METHOD_CODES[p.method] ?? '20',
        amount: parseFloat(p.amount),
      })),
      items: sale.items.map((item) => {
        const iva = IVA_CODES[item.tax_code];
        return {
          productId: String(item.product_id),
          sku: item.sku,
          // No name means the product no longer exists in faclab-core; the SRI requires one
          description: item.product_name || `Producto ${item.product_id}`,
          quantity: item.quantity,
          unitPrice: parseFloat(item.unit_price),
          discount: parseFloat(item.invoice_discount),
          taxableBase: parseFloat(item.invoice_base),
          taxCode: iva.code,
          taxRate: iva.rate,
          taxAmount: parseFloat(item.invoice_tax),
        };
      }),
    });

    // Before signing: a rejection by schema would otherwise only show up at the SRI
    const validation = await this.schemaValidator.validate(xml);
    if (!validation.valid) {
      throw new InvoiceInvalidError(
        'XML_SCHEMA_INVALID',
        `The invoice XML doesn't match the SRI schema: ${validation.errors
          .slice(0, MAX_SCHEMA_ERRORS)
          .join('; ')}`,
      );
    }

    invoice.prepare({ accessCode, signatureId: certificate.id, xml });
    await this.invoiceRepository.updateInvoice(invoice);
    logger.info({ invoiceId: invoice.id, sequence }, 'Invoice XML created');
  }

  private issuedAt(invoice: Invoice): Date {
    if (this.options.emissionDate === 'sale' && invoice.requestedAt) return invoice.requestedAt;
    return this.now();
  }

  /** Why a sale to the final consumer can't be invoiced, if it is over the limit */
  private finalConsumerOverLimit(sale: SaleData): string | null {
    if (sale.customer) return null;
    const total = toCents(sale.total);
    const limit = toCents(this.options.finalConsumerMaxTotal);
    if (total <= limit) return null;
    return `An invoice to the final consumer can't exceed USD ${formatUsd(limit)} (this sale: USD ${formatUsd(total)}): the sale needs the buyer's identification`;
  }
}

/** pagos must add up to importeTotal: faclab-core sends what each payment applied (S3.3) */
function assertPaymentsMatchTotal(sale: SaleData): void {
  const paid = sale.payments.reduce((sum, payment) => sum + toCents(payment.amount), 0);
  const total = toCents(sale.total);
  if (paid !== total) {
    throw new InvoiceInvalidError(
      'INVOICE_DATA_INVALID',
      `The payments add up to USD ${formatUsd(paid)} but the sale's total is USD ${formatUsd(total)}`,
    );
  }
}
