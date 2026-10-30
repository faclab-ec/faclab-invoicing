import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';

import { toReceivedSale } from '#/modules/invoice/app/handlers/sale-confirmed.handler';
import { Invoice } from '#/modules/invoice/domain/invoice';
import { InvoiceInvalidError } from '#/modules/invoice/domain/issue';
import { SaleConfirmedMessageSchema } from '#/modules/invoice/infra/messaging/schemas';
import { NonRetryableError } from '#/shared/errors/non-retryable.error';

import {
  InMemoryInvoiceRepository,
  makeCertificate,
  makeConfig,
  prepareCommand,
  readinessStub,
  TENANT_A,
} from '../helpers';
import { loadExamples } from './contracts';

// What faclab-core publishes, as the examples of its contract show it
const v1 = loadExamples('sales.confirmed', 1);
const v2 = loadExamples('sales.confirmed', 2);
// The company of the v2 examples and its RUC: its issuer invoices them
const EXAMPLES_TENANT = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f';
const EXAMPLES_RUC = '1799999990001';

type XmlDocument = ReturnType<DOMParser['parseFromString']>;

async function invoiceOf(example: unknown): Promise<Invoice> {
  const message = SaleConfirmedMessageSchema.parse(example);
  // v1 names no company: a development setup invoices it with its default issuer
  const { point, sale, requestedAt } = toReceivedSale(message, TENANT_A);
  const repo = new InMemoryInvoiceRepository();
  const invoice = Invoice.receive('inv-1', point, sale, new Date(), requestedAt);
  await repo.createInvoice(invoice);
  const ready = readinessStub({
    [TENANT_A]: { config: makeConfig(), certificate: makeCertificate() },
    [EXAMPLES_TENANT]: {
      config: makeConfig({ tenantId: EXAMPLES_TENANT, taxId: EXAMPLES_RUC }),
      certificate: makeCertificate({ tenantId: EXAMPLES_TENANT, taxIds: [EXAMPLES_RUC] }),
    },
  });

  // With the real XSD: every example has to build an invoice the SRI's schema accepts
  await prepareCommand(ready, repo).execute(invoice);
  return invoice;
}

type Example = { payload: { total: string; payments: { amount: string }[] } };

/**
 * v1 examples are from before S3.3: their cash payment is what the customer handed over, more than
 * the total, and such an invoice is not issued
 */
function paymentsAddUp(example: unknown): boolean {
  const { total, payments } = (example as Example).payload;
  const cents = (amount: string) => Math.round(Number(amount) * 100);
  return payments.reduce((sum, p) => sum + cents(p.amount), 0) === cents(total);
}

async function invoiceXml(example: unknown): Promise<XmlDocument> {
  const invoice = await invoiceOf(example);
  return new DOMParser().parseFromString(invoice.requireXml(), 'text/xml');
}

function texts(doc: XmlDocument, tag: string): string[] {
  return Array.from(doc.getElementsByTagName(tag)).map((node) => node.textContent ?? '');
}

/** Elements without content: the SRI schema rejects every one of them */
function emptyElements(doc: XmlDocument): string[] {
  return Array.from(doc.getElementsByTagName('*'))
    .filter((node) => !node.textContent?.trim())
    .map((node) => node.nodeName);
}

describe.each([
  ['v1', v1],
  ['v2', v2],
])('sales.confirmed %s contract', (_version, examples) => {
  const buildable = Object.keys(examples).filter((name) => paymentsAddUp(examples[name]));

  it('has the edge cases faclab-core must be able to send', () => {
    expect(Object.keys(examples)).toEqual(
      expect.arrayContaining([
        'full-customer',
        'customer-without-contact',
        'final-consumer',
        'product-without-sku',
      ]),
    );
  });

  it.each(buildable)('%s is accepted and builds a complete invoice', async (name) => {
    const doc = await invoiceXml(examples[name]);

    expect(emptyElements(doc)).toEqual([]);
    expect(Array.from(doc.getElementsByTagName('*')).map((node) => node.textContent)).not.toEqual(
      expect.arrayContaining(['null', 'undefined']),
    );
    for (const tag of [
      'tipoIdentificacionComprador',
      'razonSocialComprador',
      'identificacionComprador',
    ]) {
      expect(texts(doc, tag)).toHaveLength(1);
    }
    const lines = (examples[name].payload as { items: unknown[] }).items.length;
    expect(texts(doc, 'descripcion')).toHaveLength(lines);
  });

  it('puts the contact data the customer has in infoAdicional', async () => {
    const doc = await invoiceXml(examples['full-customer']);

    const fields = Array.from(doc.getElementsByTagName('campoAdicional')).map((node) =>
      node.getAttribute('nombre'),
    );
    expect(fields).toEqual(['Dirección', 'Telefono', 'Email']);
  });

  it('invoices a customer without email, phone or address', async () => {
    const doc = await invoiceXml(examples['customer-without-contact']);

    expect(texts(doc, 'razonSocialComprador')).toEqual(['María Quishpe']);
    expect(texts(doc, 'identificacionComprador')).toEqual(['1710034065']);
    // An empty infoAdicional breaks the SRI schema: it must not be there at all
    expect(doc.getElementsByTagName('infoAdicional')).toHaveLength(0);
  });

  it.runIf(buildable.includes('final-consumer'))(
    'invoices a final consumer with the values the SRI requires',
    async () => {
      const doc = await invoiceXml(examples['final-consumer']);

      expect(texts(doc, 'tipoIdentificacionComprador')).toEqual(['07']);
      expect(texts(doc, 'identificacionComprador')).toEqual(['9999999999999']);
      expect(texts(doc, 'razonSocialComprador')).toEqual(['CONSUMIDOR FINAL']);
      expect(doc.getElementsByTagName('infoAdicional')).toHaveLength(0);
    },
  );

  it('leaves out codigoAuxiliar without a SKU and names a product that no longer exists', async () => {
    const doc = await invoiceXml(examples['product-without-sku']);

    expect(doc.getElementsByTagName('codigoAuxiliar')).toHaveLength(0);
    expect(texts(doc, 'descripcion')).toEqual(['Corte de tubo PVC a medida', 'Producto 106']);
    expect(texts(doc, 'campoAdicional')).toEqual(['ventas@eltornillo.ec']);
  });
});

describe('sales.confirmed v1 from before S3.3', () => {
  it('has an example whose cash payment is more than the total, and refuses to number it', async () => {
    const overpaid = Object.keys(v1).filter((name) => !paymentsAddUp(v1[name]));
    expect(overpaid).toEqual(['final-consumer']);

    await expect(invoiceOf(v1['final-consumer'])).rejects.toMatchObject({
      constructor: InvoiceInvalidError,
      code: 'INVOICE_DATA_INVALID',
    });
  });
});

describe('sales.confirmed v2: who issues and from where', () => {
  it('has a branch without an address among its examples', () => {
    expect(Object.keys(v2)).toContain('branch-without-address');
  });

  it.each(Object.keys(v2))(
    '%s is invoiced by its company, at the establishment and emission point of the message',
    async (name) => {
      const payload = v2[name].payload as Record<string, string | null>;
      const invoice = await invoiceOf(v2[name]);
      const doc = new DOMParser().parseFromString(invoice.requireXml(), 'text/xml');

      expect(invoice.tenantId).toBe(v2[name].tenant_id);
      expect(texts(doc, 'ruc')).toEqual([payload.issuer_ruc]);
      expect(texts(doc, 'estab')).toEqual([payload.establishment_code]);
      expect(texts(doc, 'ptoEmi')).toEqual([payload.emission_point_code]);
      expect(texts(doc, 'dirEstablecimiento')).toEqual(
        payload.establishment_address === null ? [] : [payload.establishment_address],
      );
      // The access code carries the same RUC, establishment and emission point
      const code = invoice.requireAccessCode().value;
      expect(code.slice(10, 23)).toBe(payload.issuer_ruc);
      expect(code.slice(24, 30)).toBe(
        `${payload.establishment_code}${payload.emission_point_code}`,
      );
    },
  );

  it('is not read as v1 without its company', () => {
    const { tenant_id: _, ...withoutTenant } = v2['full-customer'];

    expect(SaleConfirmedMessageSchema.safeParse(withoutTenant).success).toBe(false);
  });
});

describe('sales.confirmed versions', () => {
  it('reads a message from before v1 as v1', () => {
    const { schema_version: _, ...legacy } = v1['full-customer'];

    expect(SaleConfirmedMessageSchema.safeParse(legacy).success).toBe(true);
  });

  it('rejects a version it does not know, so the message is kept as a dead letter', () => {
    const result = SaleConfirmedMessageSchema.safeParse({
      ...v2['full-customer'],
      schema_version: 3,
    });

    expect(result.success).toBe(false);
  });

  it('keeps v1 as a dead letter where there is no default issuer (production)', () => {
    const message = SaleConfirmedMessageSchema.parse(v1['full-customer']);

    expect(() => toReceivedSale(message, null)).toThrow(NonRetryableError);
  });

  it('invoices v1 with the default issuer at 001-001, without checking the RUC', () => {
    const message = SaleConfirmedMessageSchema.parse(v1['full-customer']);

    expect(toReceivedSale(message, TENANT_A).point).toEqual({
      tenantId: TENANT_A,
      issuerRuc: null,
      establishment: '001',
      emissionPoint: '001',
      establishmentAddress: null,
    });
  });
});
