import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';

import { PrepareInvoiceCommand } from '#/modules/invoice/app/commands/prepare-invoice';
import { Invoice } from '#/modules/invoice/domain/invoice';
import { SaleConfirmedMessageSchema } from '#/modules/invoice/infra/messaging/schemas';

import {
  configRepoStub,
  InMemoryInvoiceRepository,
  makeCertificate,
  makeConfig,
  readinessStub,
} from '../helpers';
import { loadExamples } from './contracts';

// What faclab-core publishes, as the examples of its contract show it
const examples = loadExamples('sales.confirmed');

type XmlDocument = ReturnType<DOMParser['parseFromString']>;

async function invoiceXml(example: unknown): Promise<XmlDocument> {
  const message = SaleConfirmedMessageSchema.parse(example);
  const repo = new InMemoryInvoiceRepository();
  const invoice = Invoice.receive('inv-1', message.payload);
  await repo.createInvoice(invoice);
  const ready = readinessStub({ config: makeConfig(), certificate: makeCertificate() });

  await new PrepareInvoiceCommand(ready, configRepoStub(), repo).execute(invoice);

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

describe('sales.confirmed v1 contract', () => {
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

  it.each(Object.keys(examples))('%s is accepted and builds a complete invoice', async (name) => {
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

  it('invoices a final consumer with the values the SRI requires', async () => {
    const doc = await invoiceXml(examples['final-consumer']);

    expect(texts(doc, 'tipoIdentificacionComprador')).toEqual(['07']);
    expect(texts(doc, 'identificacionComprador')).toEqual(['9999999999999']);
    expect(texts(doc, 'razonSocialComprador')).toEqual(['CONSUMIDOR FINAL']);
    expect(doc.getElementsByTagName('infoAdicional')).toHaveLength(0);
  });

  it('leaves out codigoAuxiliar without a SKU and names a product that no longer exists', async () => {
    const doc = await invoiceXml(examples['product-without-sku']);

    expect(doc.getElementsByTagName('codigoAuxiliar')).toHaveLength(0);
    expect(texts(doc, 'descripcion')).toEqual(['Corte de tubo PVC a medida', 'Producto 106']);
    expect(texts(doc, 'campoAdicional')).toEqual(['ventas@eltornillo.ec']);
  });

  it('reads a message from before v1 as v1', () => {
    const { schema_version: _, ...legacy } = examples['full-customer'];

    expect(SaleConfirmedMessageSchema.safeParse(legacy).success).toBe(true);
  });

  it('rejects a version it does not know, so the message goes to the DLQ', () => {
    const result = SaleConfirmedMessageSchema.safeParse({
      ...examples['full-customer'],
      schema_version: 2,
    });

    expect(result.success).toBe(false);
  });
});
