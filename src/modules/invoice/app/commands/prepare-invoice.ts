import { IssuerReadinessService } from '#/modules/company-config/app/issuer-readiness';
import { IssuerNotReadyError } from '#/modules/company-config/domain/readiness';
import { VoucherType } from '#/modules/company-config/domain/sequence';
import { logger } from '#/shared/logger';

import { AccessCode } from '../../domain/access-code';
import { generateAccessCode } from '../../domain/access-code-generator';
import { Invoice } from '../../domain/invoice';
import { InvoiceInvalidError } from '../../domain/issue';
import { InvoiceSchemaValidator } from '../../domain/ports';
import { InvoiceRepository } from '../../domain/repository';
import { InvoiceCommand } from './command';
import { CreditNoteVoucher } from './credit-note-voucher';
import { InvoiceVoucher, VoucherKind } from './invoice-voucher';

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

/**
 * Builds the XML of a `pending` document with its company's issuer, from the establishment and
 * emission point it says. Waits (IssuerNotReadyError) until that issuer has a valid config and a
 * usable certificate, and while the document names another RUC. What its type can't issue is
 * rejected without a number (a sale to the final consumer over the limit); an XML outside the SRI
 * schema stays here with an issue that is only retried by hand.
 */
export class PrepareInvoiceCommand implements InvoiceCommand {
  private readonly kinds: Record<VoucherType, VoucherKind>;

  constructor(
    private readiness: IssuerReadinessService,
    private invoiceRepository: InvoiceRepository,
    private schemaValidator: InvoiceSchemaValidator,
    private options: PrepareInvoiceOptions,
    private now: () => Date = () => new Date(),
  ) {
    this.kinds = {
      [VoucherType.INVOICE]: new InvoiceVoucher(options.finalConsumerMaxTotal),
      [VoucherType.CREDIT_NOTE]: new CreditNoteVoucher(),
    };
  }

  async execute(invoice: Invoice): Promise<void> {
    const kind = this.kinds[invoice.docType];

    const rejection = kind.rejection(invoice);
    if (rejection) {
      invoice.reject([rejection]);
      await this.invoiceRepository.updateInvoice(invoice);
      logger.warn({ invoiceId: invoice.id, saleId: invoice.saleId }, rejection);
      return;
    }
    kind.check(invoice);

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
        voucherType: invoice.docType,
        taxId: config.taxId,
        environment: config.environment,
        establishment: point.establishment,
        emissionPoint: point.emissionPoint,
        sequence,
        numericCode: invoice.requireNumericCode(),
      }),
    );

    const xml = kind.buildXml(invoice, {
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
      voucherTypeCode: invoice.docType,
      date: issuedAt,
    });

    // Before signing: a rejection by schema would otherwise only show up at the SRI
    const validation = await this.schemaValidator.validate(xml, invoice.docType);
    if (!validation.valid) {
      throw new InvoiceInvalidError(
        'XML_SCHEMA_INVALID',
        `The ${kind.label} XML doesn't match the SRI schema: ${validation.errors
          .slice(0, MAX_SCHEMA_ERRORS)
          .join('; ')}`,
      );
    }

    invoice.prepare({ accessCode, signatureId: certificate.id, xml });
    await this.invoiceRepository.updateInvoice(invoice);
    logger.info({ invoiceId: invoice.id, docType: invoice.docType, sequence }, 'XML created');
  }

  private issuedAt(invoice: Invoice): Date {
    if (this.options.emissionDate === 'sale' && invoice.requestedAt) return invoice.requestedAt;
    return this.now();
  }
}
