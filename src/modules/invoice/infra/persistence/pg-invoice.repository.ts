import { Pool, PoolClient } from 'pg';
import { validate as isUuid } from 'uuid';

import { formatSequence, INVOICE_DOC_TYPE } from '#/modules/company-config/domain/sequence';
import { takeNextSequence } from '#/modules/company-config/infra/persistence/pg-sequence.repository';
import { withTransaction } from '#/shared/infra/database';

import { Invoice, InvoiceStatus } from '../../domain/invoice';
import {
  ConcurrentUpdateError,
  InFlightCounts,
  InvoiceFilter,
  InvoicePage,
  InvoiceRepository,
  PageRequest,
} from '../../domain/repository';
import { fromInvoiceRow, InvoiceRow, toInvoiceEventRows, toInvoiceRow } from './invoice.mapper';

const IN_FLIGHT_STATUSES = [
  InvoiceStatus.PENDING,
  InvoiceStatus.CREATED,
  InvoiceStatus.SIGNED,
  InvoiceStatus.SENT,
];

// Every column of the invoice plus its status history, oldest entry first
const SELECT_INVOICES = `
  SELECT i.*,
    COALESCE(
      (SELECT json_agg(
          json_build_object(
            'status', e.status, 'occurred_at', e.occurred_at, 'description', e.description
          ) ORDER BY e.position)
        FROM invoice_events e
        WHERE e.invoice_id = i.id),
      '[]'::json
    ) AS status_history
  FROM invoices i`;

export class PgInvoiceRepository implements InvoiceRepository {
  constructor(private readonly pool: Pool) {}

  async createInvoice(invoice: Invoice): Promise<boolean> {
    const version = invoice.version + 1;
    const row = { ...toInvoiceRow(invoice), version };
    const created = await withTransaction(this.pool, async (client) => {
      // Skipped when the id exists or the sale already has an active invoice
      // (uq_invoices_active_sale): a concurrent resend waits for this one and finds it
      const result = await client.query(
        `INSERT INTO invoices (
           id, tenant_id, sale_id, issuer_ruc, establishment, emission_point,
           establishment_address, status, sale, access_code, sequence, signature_id, xml,
           issue_code, issue_message, issue_at, attempts, next_attempt_at, created_at,
           updated_at, version
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
           $19, $20, $21
         )
         ON CONFLICT DO NOTHING`,
        [
          row.id,
          row.tenant_id,
          row.sale_id,
          row.issuer_ruc,
          row.establishment,
          row.emission_point,
          row.establishment_address,
          row.status,
          row.sale,
          row.access_code,
          row.sequence,
          row.signature_id,
          row.xml,
          row.issue_code,
          row.issue_message,
          row.issue_at,
          row.attempts,
          row.next_attempt_at,
          row.created_at,
          row.updated_at,
          row.version,
        ],
      );
      if (result.rowCount === 0) return false;
      await this.insertEvents(client, invoice);
      return true;
    });
    if (created) invoice.version = version;
    return created;
  }

  async updateInvoice(invoice: Invoice): Promise<Invoice> {
    const expected = invoice.version;
    const row = toInvoiceRow(invoice);
    await withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE invoices SET
           status = $3, access_code = $4, sequence = $5, signature_id = $6, xml = $7,
           issue_code = $8, issue_message = $9, issue_at = $10, attempts = $11,
           next_attempt_at = $12, updated_at = $13, version = $2 + 1
         WHERE id = $1 AND version = $2`,
        [
          row.id,
          expected,
          row.status,
          row.access_code,
          row.sequence,
          row.signature_id,
          row.xml,
          row.issue_code,
          row.issue_message,
          row.issue_at,
          row.attempts,
          row.next_attempt_at,
          row.updated_at,
        ],
      );
      if (result.rowCount === 0) throw new ConcurrentUpdateError(invoice.id);
      await this.insertEvents(client, invoice);
    });
    invoice.version = expected + 1;
    return invoice;
  }

  async assignSequence(invoice: Invoice): Promise<Invoice> {
    const expected = invoice.version;
    const { point } = invoice;
    await withTransaction(this.pool, async (client) => {
      const value = await takeNextSequence(client, {
        tenantId: point.tenantId,
        establishment: point.establishment,
        emissionPoint: point.emissionPoint,
        docType: INVOICE_DOC_TYPE,
      });
      invoice.assignSequence(formatSequence(value));
      // uq_invoices_tenant_number: a number is never stored twice
      const result = await client.query(
        `UPDATE invoices SET sequence = $3, updated_at = $4, version = $2 + 1
         WHERE id = $1 AND version = $2`,
        [invoice.id, expected, invoice.sequence, invoice.updatedAt],
      );
      // Rolled back with the number: the invoice changed since it was read
      if (result.rowCount === 0) throw new ConcurrentUpdateError(invoice.id);
    });
    invoice.version = expected + 1;
    return invoice;
  }

  async getInvoiceById(id: string): Promise<Invoice | null> {
    // Not a uuid: no invoice has it (and the query would fail on the cast)
    if (!isUuid(id)) return null;
    const result = await this.pool.query<InvoiceRow>(`${SELECT_INVOICES} WHERE i.id = $1`, [id]);
    return result.rows[0] ? fromInvoiceRow(result.rows[0]) : null;
  }

  async findForTenant(tenantId: string, id: string): Promise<Invoice | null> {
    if (!isUuid(id)) return null;
    const result = await this.pool.query<InvoiceRow>(
      `${SELECT_INVOICES} WHERE i.tenant_id = $1 AND i.id = $2`,
      [tenantId, id],
    );
    return result.rows[0] ? fromInvoiceRow(result.rows[0]) : null;
  }

  async findPage(tenantId: string, filter: InvoiceFilter, page: PageRequest): Promise<InvoicePage> {
    const { where, params } = whereClause(tenantId, filter);
    const order = filter.attention
      ? 'i.updated_at DESC, i.id DESC'
      : 'i.created_at DESC, i.id DESC';
    const [rows, count] = await Promise.all([
      this.pool.query<InvoiceRow>(
        `${SELECT_INVOICES} ${where} ORDER BY ${order}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, page.limit, page.offset],
      ),
      this.pool.query<{ total: string }>(
        `SELECT count(*) AS total FROM invoices i ${where}`,
        params,
      ),
    ]);
    return { items: rows.rows.map(fromInvoiceRow), total: Number(count.rows[0].total) };
  }

  async findBySaleId(tenantId: string, saleId: string): Promise<Invoice[]> {
    const result = await this.pool.query<InvoiceRow>(
      `${SELECT_INVOICES} WHERE i.tenant_id = $1 AND i.sale_id = $2 ORDER BY i.created_at, i.id`,
      [tenantId, saleId],
    );
    return result.rows.map(fromInvoiceRow);
  }

  async countInFlight(tenantId: string): Promise<InFlightCounts> {
    const result = await this.pool.query<Record<keyof InFlightCounts, string>>(
      `SELECT count(*) AS "total",
         count(*) FILTER (WHERE i.issue_code IS NOT NULL) AS "withIssues",
         count(*) FILTER (WHERE ${NEEDS_ATTENTION}) AS "needingAttention"
       FROM invoices i
       WHERE i.tenant_id = $1 AND i.status = ANY($2)`,
      [tenantId, IN_FLIGHT_STATUSES],
    );
    const row = result.rows[0];
    return {
      total: Number(row.total),
      withIssues: Number(row.withIssues),
      needingAttention: Number(row.needingAttention),
    };
  }

  async findInFlight(): Promise<Invoice[]> {
    const result = await this.pool.query<InvoiceRow>(
      `${SELECT_INVOICES} WHERE i.status = ANY($1) ORDER BY i.created_at, i.id`,
      [IN_FLIGHT_STATUSES],
    );
    return result.rows.map(fromInvoiceRow);
  }

  // The history only grows: the entries already stored stay as they are
  private async insertEvents(client: PoolClient, invoice: Invoice): Promise<void> {
    const events = toInvoiceEventRows(invoice);
    if (events.length === 0) return;
    await client.query(
      `INSERT INTO invoice_events (invoice_id, position, status, occurred_at, description)
       SELECT $1::uuid, e.position, e.status, e.occurred_at, e.description
       FROM unnest($2::int[], $3::text[], $4::timestamptz[], $5::text[])
         AS e (position, status, occurred_at, description)
       ON CONFLICT (invoice_id, position) DO NOTHING`,
      [
        invoice.id,
        events.map((e) => e.position),
        events.map((e) => e.status),
        events.map((e) => e.occurred_at),
        events.map((e) => e.description),
      ],
    );
  }
}

// Same rule as Invoice.needsAttention, for an invoice in flight
const NEEDS_ATTENTION = `(i.issue_code IS NOT NULL OR i.status = '${InvoiceStatus.PENDING}')`;

function whereClause(
  tenantId: string,
  filter: InvoiceFilter,
): { where: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  // Always the company's: the API never lists another company's invoices
  conditions.push(`i.tenant_id = ${param(tenantId)}`);
  if (filter.status) conditions.push(`i.status = ${param(filter.status)}`);
  if (filter.createdFrom) conditions.push(`i.created_at >= ${param(filter.createdFrom)}`);
  if (filter.createdBefore) conditions.push(`i.created_at < ${param(filter.createdBefore)}`);
  if (filter.attention) {
    conditions.push(`i.status = ANY(${param(IN_FLIGHT_STATUSES)}) AND ${NEEDS_ATTENTION}`);
  }
  return { where: `WHERE ${conditions.join(' AND ')}`, params };
}
