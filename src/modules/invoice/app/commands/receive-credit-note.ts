import { VoucherType } from '#/modules/company-config/domain/sequence';
import { logger } from '#/shared/logger';

import { CreditNoteData, CreditNoteRequest, ModifiedInvoice } from '../../domain/credit-note';
import { Invoice, InvoiceStatus, TraceContext } from '../../domain/invoice';
import { ConcurrentUpdateError, InvoiceRepository } from '../../domain/repository';
import { IssuingPoint } from '../../domain/sale';
import { FINAL_CONSUMER } from '../../domain/sri-catalogs';
import { invoiceIdForEvent } from './receive-sale';

/** A `credit_notes.requested` message, with who issues and from where */
export interface ReceivedCreditNote {
  eventId: string;
  point: IssuingPoint;
  creditNote: CreditNoteRequest;
  // occurred_at of the message: when faclab-core asked for it
  requestedAt: Date;
}

/**
 * The invoice a credit note modifies, or why that invoice can't have one. NAC-DGERCGC25-00000014,
 * art. 3 (since 01/01/2026): an invoice to the final consumer admits no credit note, and the ficha
 * técnica 2.34 (5.7) requires identifying the receiver. faclab-core already refuses such a refund:
 * this is the last barrier, and the buyer is read from the invoice, where it really is.
 */
export function modifiedInvoice(source: Invoice | null): ModifiedInvoice | { problem: string } {
  if (!source) return { problem: "The invoice to modify doesn't exist in this company" };
  if (source.docType !== VoucherType.INVOICE) {
    return { problem: `Document ${source.id} is not an invoice` };
  }
  const { accessCode, sequence, sale } = source;
  if (source.status !== InvoiceStatus.AUTHORIZED || !accessCode || !sequence) {
    return { problem: `Invoice ${source.id} is not authorized (${source.status})` };
  }
  const customer = sale?.customer;
  if (!customer || customer.tax_id === FINAL_CONSUMER.taxId) {
    return {
      problem:
        "The invoice was issued to the final consumer: it doesn't admit a credit note (NAC-DGERCGC25-00000014, art. 3)",
    };
  }
  return {
    number: `${source.point.establishment}-${source.point.emissionPoint}-${sequence}`,
    issueDate: accessCode.emissionDate,
    customer,
  };
}

/**
 * Stores the credit note as a `pending` document, due right away, whether or not its issuer can
 * issue yet: the worker takes it from the queue like an invoice. What it modifies is read now, from
 * the invoice; a request that can't be issued is stored too, so faclab-core gets the rejection with
 * its reason.
 *
 * Kafka may deliver the same message twice (same event id, same document id). Asking again brings a
 * new event id: it only creates a document if the credit note has none active. If it is already
 * authorized, the result is published again: faclab-core asks again when it never got it.
 */
export class ReceiveCreditNoteCommand {
  constructor(
    private invoiceRepository: InvoiceRepository,
    // The trace of the message being handled, kept so the worker continues it
    private traceContext: () => TraceContext | null = () => null,
  ) {}

  async execute({ eventId, point, creditNote, requestedAt }: ReceivedCreditNote): Promise<void> {
    const id = invoiceIdForEvent(eventId);
    const { tenantId } = point;
    const context = { documentId: id, creditNoteId: creditNote.credit_note_id };

    if (await this.invoiceRepository.getInvoiceById(id)) {
      logger.info(context, 'Credit note already received, ignoring');
      return;
    }

    const active = await this.invoiceRepository.findActiveCreditNote(
      tenantId,
      creditNote.credit_note_id,
    );
    if (active) {
      if (active.publishResultAgain()) {
        await this.saveIgnoringConcurrent(active);
        logger.info(context, 'Credit note already authorized, publishing its result again');
        return;
      }
      logger.info({ ...context, status: active.status }, 'Credit note already in progress');
      return;
    }

    const source = await this.invoiceRepository.findForTenant(tenantId, creditNote.invoice_id);
    const modified = modifiedInvoice(source);
    const data: CreditNoteData =
      'problem' in modified
        ? { ...creditNote, modified: null, problem: modified.problem }
        : { ...creditNote, modified, problem: null };

    const document = Invoice.receiveCreditNote(
      id,
      point,
      data,
      new Date(),
      requestedAt,
      this.traceContext(),
    );
    // A concurrent delivery may have stored its document since the checks above
    if (!(await this.invoiceRepository.createInvoice(document))) {
      logger.info(context, 'Credit note already received or in progress, ignoring');
      return;
    }
    logger.info(
      { ...context, tenantId, saleId: document.saleId, problem: data.problem },
      'Credit note received',
    );
  }

  // The worker publishing the result meanwhile is enough: faclab-core gets it either way
  private async saveIgnoringConcurrent(document: Invoice): Promise<void> {
    try {
      await this.invoiceRepository.updateInvoice(document);
    } catch (error) {
      if (!(error instanceof ConcurrentUpdateError)) throw error;
    }
  }
}
