import { InvoicingStatus } from '../../app/queries/invoice.queries';
import { buyerEmail, InvoiceDelivery } from '../../domain/delivery';
import { Invoice } from '../../domain/invoice';

export function toSummaryResponse(invoice: Invoice) {
  return {
    id: invoice.id,
    saleId: invoice.saleId,
    accessCode: invoice.accessCode?.value ?? null,
    status: invoice.status,
    signatureId: invoice.signatureId,
    authorizationNumber: invoice.authorization?.number ?? null,
    authorizedAt: invoice.authorization?.authorizedAt.toISOString() ?? null,
    // Where it is (re)sent: the buyer's email of the sale
    buyerEmail: buyerEmail(invoice.sale),
    statusHistory: invoice.statusHistory.map((h) => ({
      name: h.name,
      statusDate: h.statusDate.toISOString(),
      description: h.description ?? '',
    })),
    issue: invoice.issue && {
      code: invoice.issue.code,
      message: invoice.issue.message,
      at: invoice.issue.at.toISOString(),
    },
    attempts: invoice.attempts,
    nextAttemptAt: invoice.nextAttemptAt?.toISOString() ?? null,
    createdAt: invoice.createdAt.toISOString(),
    updatedAt: invoice.updatedAt.toISOString(),
  };
}

export function toDetailResponse(invoice: Invoice) {
  return {
    ...toSummaryResponse(invoice),
    xml: invoice.xml,
  };
}

export function toStatusResponse(status: InvoicingStatus) {
  return {
    ready: status.ready,
    environment: status.environment,
    certificate: status.certificate && {
      id: status.certificate.id,
      subject: status.certificate.subject,
      validTo: status.certificate.validTo.toISOString(),
    },
    issues: status.issues,
    pendingInvoices: status.pendingInvoices,
    invoicesWithIssues: status.invoicesWithIssues,
  };
}

export function toDeliveryResponse(delivery: InvoiceDelivery) {
  return {
    id: delivery.id,
    invoiceId: delivery.invoiceId,
    kind: delivery.kind,
    recipient: delivery.recipient,
    status: delivery.status,
    attempts: delivery.attempts,
    nextAttemptAt: delivery.nextAttemptAt?.toISOString() ?? null,
    lastError: delivery.lastError,
    smtpResponse: delivery.smtpResponse,
    sentAt: delivery.sentAt?.toISOString() ?? null,
    requestedBy: delivery.requestedBy,
    createdAt: delivery.createdAt.toISOString(),
    updatedAt: delivery.updatedAt.toISOString(),
  };
}
