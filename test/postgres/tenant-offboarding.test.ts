import { randomUUID } from 'crypto';
import { mkdtemp, readdir, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import { PgCertificateRepository } from '#/modules/certificate/infra/persistence/pg-certificate.repository';
import { PgCompanyConfigRepository } from '#/modules/company-config/infra/persistence/pg-company-config.repository';
import { ExportTenantData } from '#/modules/data-protection/app/export-tenant-data';
import { OffboardTenant, resolveTenant } from '#/modules/data-protection/app/offboard-tenant';
import { PgTenantDataRepository } from '#/modules/data-protection/infra/pg-tenant-data.repository';
import { ReceiveSaleCommand } from '#/modules/invoice/app/commands/receive-sale';
import { InvoiceProcessor } from '#/modules/invoice/app/services/invoice-processor';
import { RideService } from '#/modules/invoice/app/services/ride-service';
import { SaleData } from '#/modules/invoice/domain/sale';
import { PdfKitRideRenderer } from '#/modules/invoice/infra/adapters/pdfkit-ride-renderer';
import { PgInvoiceRepository } from '#/modules/invoice/infra/persistence/pg-invoice.repository';
import { PgInvoiceQueue } from '#/modules/invoice/infra/persistence/pg-invoice-queue';

import {
  InMemoryDocumentStorage,
  invoiceSteps,
  makeCertificate,
  makeConfig,
  makePoint,
  makeReceivedSale,
  makeSale,
  readinessStub,
  RUC_A,
  RUC_B,
  TENANT_A,
  TENANT_B,
} from '../helpers';
import { describePostgres, usePostgres } from './support';

const BUYER_A: NonNullable<SaleData['customer']> = {
  id: 9,
  name: 'Construcciones Andinas Cía. Ltda.',
  tax_id: '1790012345001',
  tax_type: 'RUC',
  email: 'compras@andinas.ec',
  phone: '0999111222',
  address: 'Av. Amazonas N34-120',
};
const BUYER_B: NonNullable<SaleData['customer']> = {
  id: 7,
  name: 'Ferretería Los Pinos',
  tax_id: '1700000019',
  tax_type: 'NATIONAL_ID',
  email: 'pinos@example.com',
  phone: '0988000111',
  address: 'Calle 9 de Octubre',
};
const DAY = 24 * 60 * 60 * 1000;

// The export and the termination of a company's data (S8.7) on PostgreSQL: the folder holds
// everything of the company and nothing of another; the anonymization keeps the accounting and
// clears the personal data outside the signed documents; the purge waits for the retention
describePostgres('tenant data protection', () => {
  const pool = usePostgres();

  async function setup() {
    const storage = new InMemoryDocumentStorage();
    const invoices = new PgInvoiceRepository(pool());
    const configs = new PgCompanyConfigRepository(pool());
    const states: Record<string, { config: never; certificate: never }> = {};
    for (const [tenantId, ruc] of [
      [TENANT_A, RUC_A],
      [TENANT_B, RUC_B],
    ] as const) {
      const certificate = makeCertificate({ id: randomUUID(), tenantId, taxIds: [ruc] });
      await new PgCertificateRepository(pool()).save(certificate);
      await configs.save(
        makeConfig({ tenantId, taxId: ruc, name: `Empresa ${ruc}`, signingCertId: certificate.id }),
      );
      states[tenantId] = {
        config: (await configs.find(tenantId))! as never,
        certificate: certificate as never,
      };
    }
    const readiness = readinessStub(states);
    const processor = new InvoiceProcessor(
      invoices,
      new PgInvoiceQueue(pool()),
      invoiceSteps(invoices, readiness, { storage }),
      readiness,
      { sendMessage: async () => undefined },
    );
    const issue = async (tenantId: string, ruc: string, saleId: number, buyer: typeof BUYER_A) => {
      const invoice = (await new ReceiveSaleCommand(invoices).execute(
        makeReceivedSale(
          randomUUID(),
          makeSale({ sale_id: saleId, customer: buyer }),
          makePoint({ tenantId, issuerRuc: ruc }),
        ),
      ))!;
      await processor.run(invoice.id);
      return (await invoices.getInvoiceById(invoice.id))!;
    };
    const a = await issue(TENANT_A, RUC_A, 42, BUYER_A);
    const b = await issue(TENANT_B, RUC_B, 43, BUYER_B);
    // What the service also keeps: a dead letter, audit entries, with names
    for (const [tenantId, name] of [
      [TENANT_A, 'Ana Pérez'],
      [TENANT_B, 'Beto Ruiz'],
    ]) {
      await pool().query(
        `INSERT INTO dead_letters (consumer_group, topic, kafka_partition, kafka_offset, key,
                                   tenant_id, value, error, error_type, attempts)
         VALUES ('g', 'sales.confirmed', 0, $2, 'k', $1, '{"customer":{"name":"x"}}', 'boom',
                 'NON_RETRYABLE', 1)`,
        [tenantId, tenantId === TENANT_A ? 1 : 2],
      );
      await pool().query(
        `INSERT INTO issuer_audit (tenant_id, action, actor_id, actor_name)
         VALUES ($1, 'issuer.production_enabled', '7', $2)`,
        [tenantId, name],
      );
    }
    // The mail worker already sent what the authorizations queued
    await pool().query(
      `UPDATE invoice_deliveries SET status = 'sent', next_attempt_at = NULL,
              smtp_response = '250 accepted', message_id = '<m@example.com>', sent_at = now()`,
    );
    const data = new PgTenantDataRepository(pool());
    const rides = new RideService(storage, configs, new PdfKitRideRenderer(), 'America/Guayaquil');
    return {
      storage,
      data,
      a,
      b,
      exporter: new ExportTenantData(data, invoices, storage, rides),
      offboarding: new OffboardTenant(data, storage),
    };
  }

  const snapshot = async (tenantId: string) => {
    const result = await pool().query(
      `SELECT (SELECT md5(coalesce(string_agg(i::text, '|' ORDER BY i.id), '')) FROM invoices i
                WHERE i.tenant_id = $1) AS invoices,
              (SELECT md5(coalesce(string_agg(d::text, '|' ORDER BY d.id), ''))
                 FROM invoice_deliveries d WHERE d.tenant_id = $1) AS deliveries,
              (SELECT count(*) FROM certificates WHERE tenant_id = $1) AS certificates,
              (SELECT md5(coalesce(string_agg(a::text, '|' ORDER BY a.id), ''))
                 FROM issuer_audit a WHERE a.tenant_id = $1) AS audit`,
      [tenantId],
    );
    return result.rows[0];
  };

  const filesOf = async (directory: string): Promise<Record<string, string>> => {
    const found: Record<string, string> = {};
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else found[path.slice(directory.length + 1)] = (await readFile(path)).toString('latin1');
      }
    };
    await walk(directory);
    return found;
  };

  it('exports everything of the company and nothing of another', async () => {
    const { exporter, a } = await setup();
    const out = await mkdtemp(join(tmpdir(), 'faclab-export-'));

    const result = await exporter.execute(TENANT_A, out, 'ops');

    expect(result.failed).toEqual([]);
    expect(result.rows).toMatchObject({ issuer: 1, invoices: 1, invoice_deliveries: 1 });
    expect(result.files).toMatchObject({ xml: 1, ride: 1 });
    const files = await filesOf(result.directory);
    const code = a.accessCode!.value;
    expect(Object.keys(files).sort()).toEqual(
      expect.arrayContaining([
        'manifest.json',
        'issuer.json',
        'invoices.csv',
        'invoice-deliveries.csv',
        'certificates.csv',
        'sequences.csv',
        'issuer-audit.csv',
        `xml/${code}.xml`,
        `ride/${code}.pdf`,
      ]),
    );
    expect(files['invoices.csv']).toContain('Construcciones Andinas');
    expect(files['invoices.csv']).toContain('compras@andinas.ec');
    // Nothing of the other company, nor a secret
    const everything = Object.values(files).join('\n');
    for (const foreign of [RUC_B, 'Ferretería Los Pinos', 'pinos@example.com', TENANT_B]) {
      expect(everything).not.toContain(foreign);
    }
    expect(files['certificates.csv']).not.toContain('ciphertext');
    expect(files['issuer.json']).not.toContain('p12');
  });

  it('refuses to anonymize before the offboarding starts, during the grace period and with documents in the queue', async () => {
    const { offboarding, data } = await setup();
    await expect(offboarding.anonymize(TENANT_A, { by: 'ops' })).rejects.toMatchObject({
      code: 'OFFBOARDING_STEP_INVALID',
    });

    await offboarding.start(TENANT_A, { by: 'ops' });
    await expect(offboarding.anonymize(TENANT_A, { by: 'ops' })).rejects.toMatchObject({
      code: 'OFFBOARDING_GRACE_NOT_ENDED',
    });
    await expect(offboarding.start(TENANT_A, { by: 'ops' })).rejects.toMatchObject({
      code: 'OFFBOARDING_ALREADY_STARTED',
    });
    // A document that never reached its final state: anonymizing would leave it half done
    await pool().query(`UPDATE invoices SET status = 'sent' WHERE tenant_id = $1`, [TENANT_A]);
    await expect(
      offboarding.anonymize(TENANT_A, { by: 'ops', skipGrace: true }),
    ).rejects.toMatchObject({ code: 'OFFBOARDING_PENDING_DOCUMENTS' });

    await offboarding.cancel(TENANT_A);
    expect(await data.offboarding(TENANT_A)).toBeNull();
  });

  it('anonymizes what tax law does not need and keeps the documents', async () => {
    const { offboarding, data, a, storage } = await setup();
    const untouched = await snapshot(TENANT_B);
    const started = new Date('2026-11-25T10:00:00Z');
    await offboarding.start(TENANT_A, { by: 'ops', graceDays: 30, now: started });
    const plan = await offboarding.plan(TENANT_A);
    expect(plan.purge.certificates).toBe(1);
    expect(plan.retain.invoices).toBe(1);

    const counts = await offboarding.anonymize(TENANT_A, {
      by: 'ops',
      now: new Date(started.getTime() + 31 * DAY),
    });

    expect(counts).toMatchObject({ certificates: 1, invoice_deliveries: 1, invoices: 1 });
    // The invoice stays, the buyer's identification with it; email and phone go
    const { rows } = await pool().query(
      `SELECT status, access_code, sale->'customer' AS buyer, issue_message FROM invoices
       WHERE tenant_id = $1`,
      [TENANT_A],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('authorized');
    expect(rows[0].access_code).toBe(a.accessCode!.value);
    expect(rows[0].buyer).toMatchObject({ tax_id: BUYER_A.tax_id, name: BUYER_A.name });
    expect(rows[0].buyer).not.toHaveProperty('email');
    expect(rows[0].buyer).not.toHaveProperty('phone');
    const deliveries = await pool().query(
      `SELECT recipient, smtp_response, message_id FROM invoice_deliveries WHERE tenant_id = $1`,
      [TENANT_A],
    );
    expect(deliveries.rows).toEqual([{ recipient: null, smtp_response: null, message_id: null }]);
    // No certificate (the private key), no dead letter, no signing certificate on the issuer
    expect((await snapshot(TENANT_A)).certificates).toBe('0');
    const issuer = await pool().query(
      'SELECT signing_cert_id, email FROM issuers WHERE tenant_id = $1',
      [TENANT_A],
    );
    expect(issuer.rows[0]).toEqual({ signing_cert_id: null, email: null });
    const letters = await pool().query('SELECT count(*) FROM dead_letters WHERE tenant_id = $1', [
      TENANT_A,
    ]);
    expect(letters.rows[0].count).toBe('0');
    // The audit log is kept, with the names gone; the signed documents are exactly as they were
    const audit = await pool().query('SELECT actor_name FROM issuer_audit WHERE tenant_id = $1', [
      TENANT_A,
    ]);
    expect(audit.rows).toEqual([{ actor_name: 'Usuario anonimizado' }]);
    expect(await storage.list(`tenants/${TENANT_A}/`)).toHaveLength(1);
    expect((await data.offboarding(TENANT_A))?.anonymizedAt).toBeInstanceOf(Date);
    // The other company is exactly as it was
    expect(await snapshot(TENANT_B)).toEqual(untouched);
    await expect(
      offboarding.anonymize(TENANT_A, { by: 'ops', skipGrace: true }),
    ).rejects.toMatchObject({ code: 'OFFBOARDING_STEP_INVALID' });
  });

  it('keeps issuer_audit append-only for anything but the offboarding', async () => {
    await setup();
    await expect(
      pool().query(`UPDATE issuer_audit SET actor_name = 'x' WHERE tenant_id = $1`, [TENANT_A]),
    ).rejects.toThrow('append-only');
    await expect(
      pool().query('DELETE FROM issuer_audit WHERE tenant_id = $1', [TENANT_A]),
    ).rejects.toThrow('append-only');
  });

  it('purges after the retention, with the RUC typed, and leaves the other company alone', async () => {
    const { offboarding, data, storage } = await setup();
    const untouched = await snapshot(TENANT_B);
    const started = new Date('2026-11-25T10:00:00Z');
    await offboarding.start(TENANT_A, {
      by: 'ops',
      now: started,
      retentionEndsAt: new Date(started.getTime() + 365 * 7 * DAY),
    });
    await expect(
      offboarding.purge(TENANT_A, { by: 'ops', confirmRuc: RUC_A }),
    ).rejects.toMatchObject({ code: 'OFFBOARDING_STEP_INVALID' });
    await offboarding.anonymize(TENANT_A, { by: 'ops', skipGrace: true });
    await expect(
      offboarding.purge(TENANT_A, { by: 'ops', confirmRuc: '0000000000000' }),
    ).rejects.toMatchObject({ code: 'OFFBOARDING_STEP_INVALID' });
    await expect(
      offboarding.purge(TENANT_A, { by: 'ops', confirmRuc: RUC_A }),
    ).rejects.toMatchObject({ code: 'OFFBOARDING_RETENTION_NOT_ENDED' });

    const counts = await offboarding.purge(TENANT_A, {
      by: 'ops',
      confirmRuc: RUC_A,
      now: new Date(started.getTime() + 365 * 7 * DAY + DAY),
    });

    expect(counts).toMatchObject({ invoices: 1, objects: 1 });
    for (const table of [
      'invoices',
      'invoice_deliveries',
      'issuers',
      'certificates',
      'sequences',
      'issuer_audit',
      'dead_letters',
    ]) {
      const left = await pool().query(`SELECT count(*) FROM ${table} WHERE tenant_id = $1`, [
        TENANT_A,
      ]);
      expect(left.rows[0].count, table).toBe('0');
    }
    expect(await storage.list(`tenants/${TENANT_A}/`)).toEqual([]);
    expect(await storage.list(`tenants/${TENANT_B}/`)).toHaveLength(1);
    // The proof of erasure stays
    expect((await data.offboarding(TENANT_A))?.purgedAt).toBeInstanceOf(Date);
    expect(await snapshot(TENANT_B)).toEqual(untouched);
    expect(await data.findTenantByRuc(RUC_A)).toBeNull();
    await expect(resolveTenant(data, RUC_A)).rejects.toThrow('No company');
  });

  describe('the repository', () => {
    it('finds a company by its RUC', async () => {
      const { data } = await setup();
      expect(await data.findTenantByRuc(RUC_B)).toBe(TENANT_B);
    });
  });
});
