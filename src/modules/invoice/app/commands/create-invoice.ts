import { CompanyConfigRepository } from '#/modules/company-config/domain/repository';

import { AccessCode } from '../../domain/access-code';
import { generateAccessCode } from '../../domain/access-code-generator';
import { Invoice } from '../../domain/invoice';
import { buildInvoiceXml } from '../../domain/invoice-xml-builder';
import { InvoiceRepository } from '../../domain/repository';
import { IVA_CODES, PAYMENT_METHOD_CODES, TAX_TYPE_CODES } from '../../domain/sri-catalogs';
import { SaleConfirmedMessage } from '../../infra/messaging/schemas';

const VOUCHER_TYPE_CODE = '01';

export class CreateInvoiceCommand {
  constructor(
    private companyConfigRepository: CompanyConfigRepository,
    private invoiceRepository: InvoiceRepository,
  ) {}

  async execute(message: SaleConfirmedMessage): Promise<Invoice> {
    const companyConfig = await this.companyConfigRepository.find();
    if (!companyConfig) throw new Error('Company config not found');
    if (!companyConfig.signingCertId)
      throw new Error('No signing certificate configured in company config');

    const date = message.occurred_at;
    const { payload } = message;

    const sequenceNum = await this.companyConfigRepository.nextInvoiceSequence();
    const sequence = String(sequenceNum).padStart(9, '0');

    const accessCodeStr = generateAccessCode(date, companyConfig, payload.sale_id, sequence);

    const customer = payload.customer
      ? {
          taxIdCode: TAX_TYPE_CODES[payload.customer.tax_type] ?? '07',
          name: payload.customer.name,
          taxId: payload.customer.tax_id,
          email: payload.customer.email,
          phone: payload.customer.phone,
          address: payload.customer.address,
        }
      : {
          taxIdCode: '07',
          name: 'CONSUMIDOR FINAL',
          taxId: '9999999999999',
          email: '',
        };

    const xml = buildInvoiceXml({
      environment: companyConfig.environment,
      emissionType: companyConfig.emissionType,
      companyName: companyConfig.name,
      companyTradeName: companyConfig.tradeName,
      companyCode: companyConfig.taxId,
      companyMainAddress: companyConfig.mainAddress,
      companyBranchAddress: companyConfig.branchAddress,
      companyBranchCode: companyConfig.branchCode,
      companySalePointCode: companyConfig.salePointCode,
      companyAccountingRequired: companyConfig.accountingRequired,
      accessCode: accessCodeStr,
      sequence,
      voucherTypeCode: VOUCHER_TYPE_CODE,
      date,
      customer,
      subtotal: parseFloat(payload.subtotal),
      totalDiscount: parseFloat(payload.total_discount),
      total: parseFloat(payload.total),
      payments: payload.payments.map((p) => ({
        formaPago: PAYMENT_METHOD_CODES[p.method] ?? '20',
        amount: parseFloat(p.amount),
      })),
      items: payload.items.map((item) => {
        const iva = IVA_CODES[item.tax_code];
        return {
          productId: String(item.product_id),
          sku: item.sku,
          description: item.product_name,
          quantity: item.quantity,
          unitPrice: parseFloat(item.unit_price),
          discount: parseFloat(item.discount),
          subtotal: parseFloat(item.subtotal),
          taxCode: iva.code,
          taxRate: iva.rate,
          taxAmount: parseFloat(item.tax_amount),
        };
      }),
    });

    const invoice = Invoice.create(
      String(payload.sale_id),
      AccessCode.create(accessCodeStr),
      companyConfig.signingCertId,
      xml,
    );
    await this.invoiceRepository.createInvoice(invoice);
    return invoice;
  }
}
