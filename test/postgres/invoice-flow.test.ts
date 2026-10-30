import { randomUUID } from 'crypto';
import { expect, it, vi } from 'vitest';

import { PgCertificateRepository } from '#/modules/certificate/infra/persistence/pg-certificate.repository';
import { PgCompanyConfigRepository } from '#/modules/company-config/infra/persistence/pg-company-config.repository';
import { ReceiveSaleCommand } from '#/modules/invoice/app/commands/receive-sale';
import { SaleConfirmedHandler } from '#/modules/invoice/app/handlers/sale-confirmed.handler';
import { InvoiceProcessor } from '#/modules/invoice/app/services/invoice-processor';
import { InvoiceResultEvent } from '#/modules/invoice/domain/events';
import { InvoiceStatus } from '#/modules/invoice/domain/invoice';
import { PgInvoiceRepository } from '#/modules/invoice/infra/persistence/pg-invoice.repository';
import { PgInvoiceQueue } from '#/modules/invoice/infra/persistence/pg-invoice-queue';
import { InvoiceWorker } from '#/modules/invoice/infra/queue/invoice-worker';

import {
  InMemoryDocumentStorage,
  invoiceSteps,
  makeCertificate,
  makeConfig,
  makePoint,
  makeReceivedSale,
  makeSale,
  makeSaleMessage,
  readinessStub,
  REQUESTED_AT,
  RUC_A,
  RUC_B,
  TENANT_A,
  TENANT_B,
} from '../helpers';
import { describePostgres, usePostgres } from './support';

describePostgres('Invoice flow on PostgreSQL', () => {
  const pool = usePostgres();

  it('leaves a single active invoice when resends of a sale arrive at the same time', async () => {
    const invoices = new PgInvoiceRepository(pool());
    const receive = new ReceiveSaleCommand(invoices);

    for (const saleId of [71, 72, 73]) {
      const sale = makeSale({ sale_id: saleId });
      // Different event ids: resends from faclab-core, not Kafka redeliveries
      const received = await Promise.all([
        receive.execute(makeReceivedSale(randomUUID(), sale)),
        receive.execute(makeReceivedSale(randomUUID(), sale)),
      ]);

      expect(received.filter((invoice) => invoice !== null)).toHaveLength(1);
      const stored = await invoices.findBySaleId(TENANT_A, String(saleId));
      expect(stored.filter((invoice) => invoice.isActive)).toHaveLength(1);
    }
  });

  it("takes two companies' sales, at the same time, to invoices numbered on their own", async () => {
    const invoices = new PgInvoiceRepository(pool());
    const configs = new PgCompanyConfigRepository(pool());
    const certificates = new PgCertificateRepository(pool());
    const issuers = [
      { tenantId: TENANT_A, taxId: RUC_A },
      { tenantId: TENANT_B, taxId: RUC_B },
    ];
    const ready: Parameters<typeof readinessStub>[0] = {};
    for (const { tenantId, taxId } of issuers) {
      const certificate = makeCertificate({ id: randomUUID(), tenantId, taxIds: [taxId] });
      await certificates.save(certificate);
      await configs.save(makeConfig({ tenantId, taxId, signingCertId: certificate.id }));
      ready[tenantId] = { config: (await configs.find(tenantId))!, certificate };
    }
    const readiness = readinessStub(ready);
    const storage = new InMemoryDocumentStorage();

    const published: InvoiceResultEvent[] = [];
    const producer = {
      sendMessage: vi.fn(async (event: InvoiceResultEvent) => void published.push(event)),
    };
    const processor = new InvoiceProcessor(
      invoices,
      new PgInvoiceQueue(pool()),
      invoiceSteps(invoices, readiness, { storage }),
      readiness,
      producer,
    );
    const worker = new InvoiceWorker(new PgInvoiceQueue(pool()), processor, {
      concurrency: 2,
      pollIntervalMs: 10,
      leaseMs: 60_000,
      errorBackoffMs: 60_000,
      holder: 'worker-1',
    });
    const saleHandler = new SaleConfirmedHandler(new ReceiveSaleCommand(invoices));

    // The same sale id in both companies, received at once; the worker takes them from the queue
    await Promise.all(
      issuers.map(({ tenantId, taxId }) =>
        saleHandler.handle(
          makeSaleMessage(randomUUID(), makeSale(), makePoint({ tenantId, issuerRuc: taxId })),
        ),
      ),
    );
    worker.start();
    await vi.waitFor(() => expect(published).toHaveLength(2), { timeout: 10_000 });
    await worker.stop();

    // faclab-core hears only of the result, once per company
    expect(published.map((e) => [e.tenantId, e.type]).sort()).toEqual(
      [
        [TENANT_A, 'InvoiceAuthorized'],
        [TENANT_B, 'InvoiceAuthorized'],
      ].sort(),
    );
    const [ofB] = await invoices.findBySaleId(TENANT_B, '42');
    expect(ofB.status).toBe(InvoiceStatus.AUTHORIZED);
    expect(ofB.sequence).toBe('000000001');
    expect(ofB.xml).toContain(`<ruc>${RUC_B}</ruc>`);
    const [invoice] = await invoices.findBySaleId(TENANT_A, '42');
    expect(invoice.status).toBe(InvoiceStatus.AUTHORIZED);
    expect(invoice.sequence).toBe('000000001');
    expect(invoice.xml).toContain(`<ruc>${RUC_A}</ruc>`);
    expect(invoice.xml).toContain('<secuencial>000000001</secuencial>');
    expect(invoice.xml).toContain('<!-- signed -->');
    expect(invoice.issue).toBeNull();
    // Stored and read back: the request date, the numeric code and the authorization
    const accessCode = invoice.requireAccessCode().value;
    expect(invoice.requestedAt).toEqual(REQUESTED_AT);
    expect(invoice.numericCode).toBe(accessCode.slice(39, 47));
    expect(invoice.authorization).toEqual({
      number: accessCode,
      authorizedAt: new Date('2026-10-09T15:01:02Z'),
      xmlKey: `tenants/${TENANT_A}/invoices/2026/${accessCode}.xml`,
    });
    expect(storage.objects.has(invoice.authorization!.xmlKey)).toBe(true);

    const { rows } = await pool().query(
      'SELECT status, description FROM invoice_events WHERE invoice_id = $1 ORDER BY position',
      [invoice.id],
    );
    expect(rows).toEqual([
      { status: 'pending', description: 'Sale received' },
      { status: 'created', description: 'XML created' },
      { status: 'signed', description: 'XML signed' },
      { status: 'sent', description: 'RECIBIDA' },
      { status: 'authorized', description: 'AUTORIZADO' },
    ]);
    const counters = await pool().query(
      'SELECT tenant_id, last_value FROM sequences ORDER BY tenant_id',
    );
    expect(counters.rows).toEqual(
      [
        { tenant_id: TENANT_A, last_value: '1' },
        { tenant_id: TENANT_B, last_value: '1' },
      ].sort((a, b) => a.tenant_id.localeCompare(b.tenant_id)),
    );
  });
});
