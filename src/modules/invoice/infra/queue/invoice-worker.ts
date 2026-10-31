import { Heartbeat, QueueWorker, QueueWorkerOptions } from '#/shared/infra/queue-worker';

import { InvoiceProcessor } from '../../app/services/invoice-processor';
import { ClaimedInvoice, InvoiceQueue } from '../../domain/queue';

export type { Heartbeat } from '#/shared/infra/queue-worker';
export type InvoiceWorkerOptions = QueueWorkerOptions;

/**
 * Takes due invoices from the queue and runs their steps, `concurrency` at a time, each in a
 * `process invoice` span that continues the trace of the message that brought the sale.
 */
export class InvoiceWorker extends QueueWorker<ClaimedInvoice> {
  constructor(
    queue: InvoiceQueue,
    processor: InvoiceProcessor,
    options: InvoiceWorkerOptions,
    heartbeat?: Heartbeat,
  ) {
    super(
      queue,
      (job, lease) => processor.run(job.id, { lease }),
      {
        name: 'Invoice worker',
        spanName: 'process invoice',
        attributes: (job) => ({ 'faclab.invoice.id': job.id }),
        logFields: (job) => ({ invoiceId: job.id }),
      },
      options,
      heartbeat,
    );
  }
}
