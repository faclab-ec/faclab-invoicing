import { IssuerReadinessService } from '#/modules/company-config/app/issuer-readiness';
import { IssuerNotReadyError } from '#/modules/company-config/domain/readiness';
import { logger } from '#/shared/logger';

import { AccessCode } from '../../domain/access-code';
import { generateAccessCode } from '../../domain/access-code-generator';
import { Invoice } from '../../domain/invoice';
import { buildInvoiceXml } from '../../domain/invoice-xml-builder';
import { InvoiceRepository } from '../../domain/repository';
import { IVA_CODES, PAYMENT_METHOD_CODES, TAX_TYPE_CODES } from '../../domain/sri-catalogs';
import { InvoiceCommand } from './command';

const VOUCHER_TYPE_CODE = '01';

/**
 * Builds the XML of a `pending` invoice with its company's issuer, from the establishment and
 * emission point of its sale. Waits (IssuerNotReadyError) until that issuer has a valid config and
 * a usable certificate, and while the sale names another RUC.
 */
export class PrepareInvoiceCommand implements InvoiceCommand {
  constructor(
    private readiness: IssuerReadinessService,
    private invoiceRepository: InvoiceRepository,
  ) {}

  async execute(invoice: Invoice): Promise<void> {
    const { point } = invoice;
    const { config, certificate } = await this.readiness.requireReady(point.tenantId);
    const sale = invoice.sale;
    if (!sale) throw new Error(`Invoice ${invoice.id} has no sale data`);
    if (point.issuerRuc !== null && point.issuerRuc !== config.taxId) {
      throw new IssuerNotReadyError(
        'ISSUER_RUC_MISMATCH',
        `The sale was made by the RUC ${point.issuerRuc}, but the company's fiscal profile has ${config.taxId}`,
      );
    }

    // Saved before building the XML so a failed attempt doesn't burn another number
    if (invoice.sequence === null) {
      await this.invoiceRepository.assignSequence(invoice);
    }
    const sequence = invoice.sequence!;

    // Emission date: when the XML is built. An invoice that waited for the
    // issuer is dated after its sale (the SRI rejects late emission dates)
    const issuedAt = new Date();
    const accessCode = AccessCode.create(
      generateAccessCode({
        date: issuedAt,
        taxId: config.taxId,
        environment: config.environment,
        establishment: point.establishment,
        emissionPoint: point.emissionPoint,
        sequence,
        saleId: sale.sale_id,
      }),
    );

    const customer = sale.customer
      ? {
          taxIdCode: TAX_TYPE_CODES[sale.customer.tax_type] ?? '07',
          name: sale.customer.name,
          taxId: sale.customer.tax_id,
          email: sale.customer.email,
          phone: sale.customer.phone,
          address: sale.customer.address,
        }
      : {
          taxIdCode: '07',
          name: 'CONSUMIDOR FINAL',
          taxId: '9999999999999',
        };

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

    invoice.prepare({ accessCode, signatureId: certificate.id, xml });
    await this.invoiceRepository.updateInvoice(invoice);
    logger.info({ invoiceId: invoice.id, sequence }, 'Invoice XML created');
  }
}
