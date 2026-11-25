import { randomUUID } from 'crypto';
import { expect, it } from 'vitest';

import { Environment } from '#/modules/company-config/domain/company-config';
import { SequenceKey, VoucherType } from '#/modules/company-config/domain/sequence';
import { PgCompanyConfigRepository } from '#/modules/company-config/infra/persistence/pg-company-config.repository';
import { PgIssuerProductionRepository } from '#/modules/company-config/infra/persistence/pg-issuer-production.repository';
import { PgSequenceRepository } from '#/modules/company-config/infra/persistence/pg-sequence.repository';
import { Invoice } from '#/modules/invoice/domain/invoice';
import { ONBOARDING_SALE_SOURCE } from '#/modules/invoice/domain/sale';
import { PgInvoiceRepository } from '#/modules/invoice/infra/persistence/pg-invoice.repository';

import { makeConfig, makePoint, makeSale, TENANT_A, TENANT_B } from '../helpers';
import { describePostgres, usePostgres } from './support';

const KEY: SequenceKey = {
  tenantId: TENANT_A,
  establishment: '001',
  emissionPoint: '001',
  docType: VoucherType.INVOICE,
};
const ACTOR = { id: '7', username: 'ana' };

// The step to production on PostgreSQL (S8.5): one transaction for the environment, the counters,
// the test invoices and the audit, and an audit that nobody can change
describePostgres('going to production', () => {
  const pool = usePostgres();
  const invoices = () => new PgInvoiceRepository(pool());
  const sequences = () => new PgSequenceRepository(pool());
  const production = () => new PgIssuerProductionRepository(pool());

  const issue = async (saleId: number, source: string, tenantId = TENANT_A) => {
    const invoice = Invoice.receive(
      randomUUID(),
      makePoint({ tenantId }),
      makeSale({ sale_id: saleId, source }),
      new Date(),
    );
    await invoices().createInvoice(invoice);
    return invoices().assignSequence(invoice);
  };

  const inTesting = async (tenantId = TENANT_A) =>
    new PgCompanyConfigRepository(pool()).save(
      makeConfig({ tenantId, environment: Environment.TESTING, signingCertId: null }),
    );

  it('moves the environment, forgets the tests, gives their numbers back and audits it', async () => {
    await inTesting();
    // The wizard set the numbering to continue from 500; the test invoice took 500
    await sequences().setNext(KEY, 500);
    const test = await issue(-1, ONBOARDING_SALE_SOURCE);
    expect(test.sequence).toBe('000000500');

    const result = await production().enterProduction(TENANT_A, ACTOR);

    expect(result).toEqual({ removedTestInvoices: 1, restoredSequences: 1 });
    const config = await new PgCompanyConfigRepository(pool()).find(TENANT_A);
    expect(config?.environment).toBe(Environment.PRODUCTION);
    expect(await invoices().getInvoiceById(test.id)).toBeNull();
    expect((await sequences().find(KEY))?.lastValue).toBe(499);
    // The first invoice of production takes the number the test had
    const real = await issue(10, 'pos');
    expect(real.sequence).toBe('000000500');
    const audit = await pool().query(
      'SELECT action, actor_id, actor_name, detail FROM issuer_audit WHERE tenant_id = $1',
      [TENANT_A],
    );
    expect(audit.rows).toEqual([
      {
        action: 'issuer.production_enabled',
        actor_id: '7',
        actor_name: 'ana',
        detail: {
          environment: { from: 1, to: 2 },
          removedTestInvoices: 1,
          restoredSequences: 1,
        },
      },
    ]);
  });

  it('keeps the counter of a point that moved on and the invoices of real sales', async () => {
    await inTesting();
    const test = await issue(-1, ONBOARDING_SALE_SOURCE);
    // A real sale issued in the test environment took the next number: giving the first back
    // would issue it twice
    const sale = await issue(10, 'pos');
    expect([test.sequence, sale.sequence]).toEqual(['000000001', '000000002']);

    const result = await production().enterProduction(TENANT_A, ACTOR);

    expect(result).toEqual({ removedTestInvoices: 1, restoredSequences: 0 });
    expect((await sequences().find(KEY))?.lastValue).toBe(2);
    expect(await invoices().getInvoiceById(sale.id)).not.toBeNull();
  });

  it('only touches its own company and only once', async () => {
    await inTesting();
    await inTesting(TENANT_B);
    const other = await issue(-1, ONBOARDING_SALE_SOURCE, TENANT_B);

    expect(await production().enterProduction(TENANT_A, ACTOR)).not.toBeNull();
    expect(await production().enterProduction(TENANT_A, ACTOR)).toBeNull();

    expect(await invoices().getInvoiceById(other.id)).not.toBeNull();
    expect((await new PgCompanyConfigRepository(pool()).find(TENANT_B))?.environment).toBe(
      Environment.TESTING,
    );
    const count = await pool().query('SELECT count(*)::int AS n FROM issuer_audit');
    expect(count.rows[0].n).toBe(1);
    // A company without profile isn't moved either
    expect(
      await production().enterProduction('99999999-9999-4999-8999-999999999999', ACTOR),
    ).toBeNull();
  });

  it('cannot be edited nor erased', async () => {
    await inTesting();
    await production().enterProduction(TENANT_A, ACTOR);

    await expect(pool().query("UPDATE issuer_audit SET actor_name = 'otra'")).rejects.toThrow(
      /append-only/,
    );
    await expect(pool().query('DELETE FROM issuer_audit')).rejects.toThrow(/append-only/);
  });
});
