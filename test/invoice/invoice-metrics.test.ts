import { describe, expect, it, vi } from 'vitest';

import { IssuerReadinessService } from '#/modules/company-config/app/issuer-readiness';
import { IssuerNotReadyError } from '#/modules/company-config/domain/readiness';
import { VoucherType } from '#/modules/company-config/domain/sequence';
import { ReceiveCreditNoteCommand } from '#/modules/invoice/app/commands/receive-credit-note';
import { ReceiveSaleCommand } from '#/modules/invoice/app/commands/receive-sale';
import { CreditNoteRequestedHandler } from '#/modules/invoice/app/handlers/credit-note-requested.handler';
import { InvoiceProcessor } from '#/modules/invoice/app/services/invoice-processor';
import { VoucherResultEvent } from '#/modules/invoice/domain/events';
import { Invoice } from '#/modules/invoice/domain/invoice';
import { InvoiceInvalidError, InvoiceIssueError } from '#/modules/invoice/domain/issue';
import { SriAuthorizationPort, SriValidationPort } from '#/modules/invoice/domain/ports';
import { ConcurrentUpdateError } from '#/modules/invoice/domain/repository';
import { ValidationVoucher, ValidationVoucherStatus } from '#/modules/invoice/domain/voucher';
import { recordDelivery } from '#/modules/invoice/infra/telemetry/delivery-metrics';
import { measureSteps, stepOutcome } from '#/modules/invoice/infra/telemetry/step-metrics';

import {
  InMemoryInvoiceRepository,
  invoiceSteps,
  makeCertificate,
  makeConfig,
  makeCreditNoteMessage,
  makePoint,
  makeReceivedSale,
  makeSale,
  readinessStub,
  TENANT_A,
} from '../helpers';
import { useRecordedMetrics } from '../metrics';

const recorded = useRecordedMetrics();

const READY = readinessStub({ config: makeConfig(), certificate: makeCertificate() });

function setup(
  readiness: IssuerReadinessService = READY,
  sri: Partial<SriValidationPort & SriAuthorizationPort> = {},
) {
  const repo = new InMemoryInvoiceRepository();
  const published: VoucherResultEvent[] = [];
  const processor = new InvoiceProcessor(
    repo,
    repo,
    measureSteps(invoiceSteps(repo, readiness, { sri })),
    readiness,
    { sendMessage: vi.fn(async (event: VoucherResultEvent) => void published.push(event)) },
  );
  return { repo, processor };
}

async function received(
  repo: InMemoryInvoiceRepository,
  requestedAt: Date | null,
  arrivedAt = new Date(),
) {
  const invoice = Invoice.receive('inv-1', makePoint(), makeSale(), arrivedAt, requestedAt);
  await repo.createInvoice(invoice);
  return invoice;
}

const TRANSITIONS = 'faclab.invoices.transitions';
const STEPS = 'faclab.invoices.step.duration';
const TIME_TO_FINAL = 'faclab.invoices.time_to_final';

describe('Metrics of the documents on their way', () => {
  it('counts each saved transition up to the authorization, each step and the time since the sale', async () => {
    const { repo, processor } = setup();
    // faclab-core confirmed the sale a minute and a half ago
    await received(repo, new Date(Date.now() - 90_000));

    await processor.run('inv-1');

    const points = await recorded.collect();
    const invoice = { 'faclab.document.type': 'invoice' };
    for (const [from, to] of [
      ['pending', 'created'],
      ['created', 'signed'],
      ['signed', 'sent'],
      ['sent', 'authorized'],
    ]) {
      expect(points.total(TRANSITIONS, { from, to, ...invoice })).toBe(1);
    }
    expect(points.total(TRANSITIONS)).toBe(4);
    for (const step of ['prepare', 'sign', 'send', 'authorize']) {
      expect(
        points.total(STEPS, {
          'faclab.invoice.step': step,
          'faclab.step.outcome': 'advanced',
          ...invoice,
        }),
      ).toBe(1);
    }
    const [toFinal] = points.of(TIME_TO_FINAL, { result: 'authorized', ...invoice });
    expect(toFinal.value).toBe(1);
    expect(toFinal.histogram!.sum).toBeGreaterThanOrEqual(90);
    expect(toFinal.histogram!.sum).toBeLessThan(100);
  });

  it('counts a document the SRI returns as rejected from signed', async () => {
    const { repo, processor } = setup(READY, {
      validateXml: async () =>
        new ValidationVoucher(ValidationVoucherStatus.REJECTED, null, [
          'ERROR 35 : ARCHIVO NO CUMPLE ESTRUCTURA XML : ',
        ]),
    });
    await received(repo, new Date(Date.now() - 5_000));

    await processor.run('inv-1');

    const points = await recorded.collect();
    expect(points.total(TRANSITIONS, { from: 'signed', to: 'rejected' })).toBe(1);
    expect(points.total(TRANSITIONS, { to: 'sent' })).toBe(0);
    expect(points.total(TIME_TO_FINAL, { result: 'rejected' })).toBe(1);
    expect(points.total(TIME_TO_FINAL, { result: 'authorized' })).toBe(0);
  });

  it('measures from the arrival when the message had no date', async () => {
    const { repo, processor } = setup();
    // Arrived two minutes ago
    await received(repo, null, new Date(Date.now() - 120_000));

    await processor.run('inv-1');

    const [toFinal] = (await recorded.collect()).of(TIME_TO_FINAL);
    expect(toFinal.histogram!.sum).toBeGreaterThanOrEqual(120);
  });

  it('counts a failed step by its outcome, and no transition', async () => {
    const notReady = readinessStub(
      new IssuerNotReadyError('CERTIFICATE_EXPIRED', 'The signing certificate expired'),
    );
    const blocked = setup(notReady);
    await received(blocked.repo, new Date());
    await blocked.processor.run('inv-1');

    const sriDown = setup(READY, {
      validateXml: async () => {
        throw new InvoiceIssueError('SRI_UNAVAILABLE', 'SRI reception service failed: timeout');
      },
    });
    await received(sriDown.repo, new Date());
    await sriDown.processor.run('inv-1');

    const points = await recorded.collect();
    expect(
      points.total(STEPS, { 'faclab.invoice.step': 'prepare', 'faclab.step.outcome': 'blocked' }),
    ).toBe(1);
    expect(
      points.total(STEPS, { 'faclab.invoice.step': 'send', 'faclab.step.outcome': 'retry' }),
    ).toBe(1);
    // The second one moved up to signed; nothing after
    expect(points.total(TRANSITIONS)).toBe(2);
    expect(points.total(TIME_TO_FINAL)).toBe(0);
  });

  it('classifies how a step failed as the issue it leaves', () => {
    expect(stepOutcome(new IssuerNotReadyError('CONFIG_MISSING', 'x'))).toBe('blocked');
    expect(stepOutcome(new InvoiceInvalidError('XML_SCHEMA_INVALID', 'x'))).toBe('invalid');
    expect(stepOutcome(new InvoiceIssueError('SRI_PROCESSING', 'x'))).toBe('retry');
    expect(stepOutcome(new Error('database down'))).toBe('retry');
    expect(stepOutcome(new ConcurrentUpdateError('inv-1'))).toBe('conflict');
  });

  it('tells credit notes apart from invoices', async () => {
    const { repo, processor } = setup();
    // A credit note needs a buyer: the final consumer's invoice can't be credited
    const customer = {
      id: 9,
      name: 'Construcciones Andinas Cía. Ltda.',
      tax_id: '1790012345001',
      tax_type: 'RUC' as const,
      email: null,
      phone: null,
      address: null,
    };
    const invoice = (await new ReceiveSaleCommand(repo).execute(
      makeReceivedSale('33333333-3333-4333-8333-333333333333', makeSale({ customer })),
    ))!;
    await processor.run(invoice.id);
    await new CreditNoteRequestedHandler(new ReceiveCreditNoteCommand(repo)).handle(
      makeCreditNoteMessage({ invoice_id: invoice.id }),
    );
    const [creditNote] = await repo.findBySaleId(TENANT_A, '42', VoucherType.CREDIT_NOTE);

    await processor.run(creditNote.id);

    const points = await recorded.collect();
    const credit = { 'faclab.document.type': 'credit_note' };
    expect(points.total(TRANSITIONS, credit)).toBe(4);
    expect(points.total(TRANSITIONS, { 'faclab.document.type': 'invoice' })).toBe(4);
    expect(points.total(TIME_TO_FINAL, { result: 'authorized', ...credit })).toBe(1);
  });
});

describe('Metrics of the deliveries', () => {
  it('counts how each attempt ended; a pending one waits for the next', async () => {
    recordDelivery('sent');
    recordDelivery('pending');
    recordDelivery('bounced');
    recordDelivery('no_recipient');
    recordDelivery(null);

    const points = await recorded.collect();
    const deliveries = 'faclab.invoices.deliveries';
    expect(points.total(deliveries, { result: 'sent' })).toBe(1);
    expect(points.total(deliveries, { result: 'retry' })).toBe(1);
    expect(points.total(deliveries, { result: 'bounced' })).toBe(1);
    expect(points.total(deliveries, { result: 'no_recipient' })).toBe(1);
    expect(points.total(deliveries)).toBe(4);
  });
});
