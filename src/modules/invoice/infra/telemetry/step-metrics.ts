import {
  invoiceStepDuration,
  invoiceTimeToFinal,
  invoiceTransitions,
} from '#/shared/telemetry/metrics';

import { InvoiceCommand } from '../../app/commands/command';
import { Invoice, InvoiceStatus } from '../../domain/invoice';
import { isBlockingIssue, isInvalidIssue, issueFromError } from '../../domain/issue';
import { ConcurrentUpdateError } from '../../domain/repository';
import { documentTypeLabel } from './attributes';

// The step each status runs
const STEP_OF: Record<string, string> = {
  [InvoiceStatus.PENDING]: 'prepare',
  [InvoiceStatus.CREATED]: 'sign',
  [InvoiceStatus.SIGNED]: 'send',
  [InvoiceStatus.SENT]: 'authorize',
};

/**
 * How a step ended: it moved the document (`advanced`, a rejection too) or it failed and the
 * document waits for its issuer (`blocked`), for a manual retry (`invalid`), for the next attempt
 * (`retry`), or someone else moved it meanwhile (`conflict`). The same classes as the issue it leaves
 */
export function stepOutcome(error: unknown): string {
  if (error instanceof ConcurrentUpdateError) return 'conflict';
  const { code } = issueFromError(error, new Date());
  if (isBlockingIssue(code)) return 'blocked';
  if (isInvalidIssue(code)) return 'invalid';
  return 'retry';
}

/**
 * Measures each step of the documents: its duration and outcome, the status change it saved and,
 * once the document is final, how long it took since faclab-core asked for it. A step that returns
 * has saved its change, so only what was saved is counted.
 */
class MeasuredStep implements InvoiceCommand {
  constructor(
    private readonly step: string,
    private readonly command: InvoiceCommand,
  ) {}

  async execute(invoice: Invoice): Promise<void> {
    const from = invoice.status;
    const documentType = documentTypeLabel(invoice.docType);
    const startTime = performance.now();
    const record = (outcome: string) =>
      invoiceStepDuration.record((performance.now() - startTime) / 1000, {
        'faclab.invoice.step': this.step,
        'faclab.step.outcome': outcome,
        'faclab.document.type': documentType,
      });

    try {
      await this.command.execute(invoice);
    } catch (error) {
      record(stepOutcome(error));
      throw error;
    }
    record('advanced');

    if (invoice.status === from) return;
    invoiceTransitions.add(1, { from, to: invoice.status, 'faclab.document.type': documentType });
    if (invoice.isFinal) {
      invoiceTimeToFinal.record(timeToFinal(invoice), {
        result: invoice.status === InvoiceStatus.AUTHORIZED ? 'authorized' : 'rejected',
        'faclab.document.type': documentType,
      });
    }
  }
}

/**
 * Seconds from faclab-core's request (`occurred_at` of the message that brought the sale: its
 * confirmation or a resend) to the final status; from the arrival for documents received before
 * that was kept. Never negative, whatever the clocks of both services say
 */
export function timeToFinal(invoice: Invoice): number {
  const final = invoice.statusHistory[invoice.statusHistory.length - 1].statusDate;
  const since = invoice.requestedAt ?? invoice.createdAt;
  return Math.max(0, (final.getTime() - since.getTime()) / 1000);
}

/** The same steps, each one measured */
export function measureSteps(
  commands: Map<InvoiceStatus, InvoiceCommand>,
): Map<InvoiceStatus, InvoiceCommand> {
  return new Map(
    [...commands].map(([status, command]) => [
      status,
      new MeasuredStep(STEP_OF[status] ?? 'other', command),
    ]),
  );
}
