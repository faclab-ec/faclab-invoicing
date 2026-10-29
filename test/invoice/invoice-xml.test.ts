import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';

import { buildAuthorizedXml } from '#/modules/invoice/domain/authorized-xml';
import { buildInvoiceXml, InvoiceXmlInput } from '#/modules/invoice/domain/invoice-xml-builder';

import { xsdValidator } from '../helpers';

const ACCESS_CODE = '0910202601179214100100110010010000000011234567812';

function input(overrides: Partial<InvoiceXmlInput> = {}): InvoiceXmlInput {
  return {
    environment: 1,
    emissionType: 1,
    companyName: 'ACME S.A.',
    companyTradeName: 'ACME',
    companyCode: '1792141001001',
    companyMainAddress: 'Quito',
    companyBranchAddress: 'Av. Amazonas N34-120, Quito',
    companyBranchCode: '001',
    companySalePointCode: '001',
    companyAccountingRequired: true,
    companySpecialTaxpayerResolution: null,
    companyWithholdingAgentResolution: null,
    companyRimpeRegime: null,
    providerRuc: null,
    accessCode: ACCESS_CODE,
    sequence: '000000001',
    voucherTypeCode: '01',
    date: new Date('2026-10-09T15:00:00Z'),
    customer: { taxIdCode: '07', name: 'CONSUMIDOR FINAL', taxId: '9999999999999' },
    total: 11.5,
    payments: [{ formaPago: '01', amount: 11.5 }],
    items: [
      {
        productId: '7',
        sku: 'SKU-7',
        description: 'Producto',
        quantity: 1,
        unitPrice: 10,
        discount: 0,
        taxableBase: 10,
        taxCode: 4,
        taxRate: 15,
        taxAmount: 1.5,
      },
    ],
    ...overrides,
  };
}

const texts = (xml: string, tag: string) =>
  Array.from(new DOMParser().parseFromString(xml, 'text/xml').getElementsByTagName(tag)).map(
    (node) => node.textContent,
  );

async function expectValid(xml: string) {
  expect(await xsdValidator.validate(xml)).toEqual({ valid: true, errors: [] });
}

describe('buildInvoiceXml against the SRI schema (factura 1.1.0)', () => {
  it('builds an invoice the XSD accepts', async () => {
    await expectValid(buildInvoiceXml(input()));
  });

  it('writes every legend of the issuer in the order of the schema', async () => {
    const xml = buildInvoiceXml(
      input({
        companySpecialTaxpayerResolution: '5368',
        companyWithholdingAgentResolution: '12345678',
        companyRimpeRegime: null,
        providerRuc: '0990012345001',
      }),
    );

    await expectValid(xml);
    expect(texts(xml, 'agenteRetencion')).toEqual(['12345678']);
    expect(texts(xml, 'contribuyenteEspecial')).toEqual(['5368']);
    expect(xml).toContain('<campoAdicional nombre="RUC Proveedor">0990012345001</campoAdicional>');
  });

  it('leaves out the legends that do not apply', () => {
    const xml = buildInvoiceXml(input());

    for (const tag of ['agenteRetencion', 'contribuyenteRimpe', 'contribuyenteEspecial']) {
      expect(texts(xml, tag)).toEqual([]);
    }
  });

  it('fits texts to the schema: one line, at most 300 characters, no SKU over 25', async () => {
    const xml = buildInvoiceXml(
      input({
        customer: {
          taxIdCode: '04',
          name: 'Ferretería\nEl Tornillo  \r\n Cía. Ltda.',
          taxId: '1790012345001',
          address: 'x'.repeat(400),
        },
        items: [
          {
            ...input().items[0],
            sku: 'S'.repeat(26),
            description: `Tubo PVC\n${'1'.repeat(400)}`,
          },
        ],
      }),
    );

    await expectValid(xml);
    expect(texts(xml, 'razonSocialComprador')).toEqual(['Ferretería El Tornillo Cía. Ltda.']);
    expect(texts(xml, 'descripcion')[0]).toHaveLength(300);
    expect(texts(xml, 'codigoAuxiliar')).toEqual([]);
    expect(texts(xml, 'campoAdicional')[0]).toHaveLength(300);
  });

  it('leaves pagos out of a sale without payments', async () => {
    const xml = buildInvoiceXml(
      input({
        total: 0,
        payments: [],
        items: [{ ...input().items[0], unitPrice: 0, taxableBase: 0, taxAmount: 0 }],
      }),
    );

    await expectValid(xml);
    expect(texts(xml, 'pagos')).toEqual([]);
  });

  it('reports what the schema rejects', async () => {
    const xml = buildInvoiceXml(input({ companyCode: '179214100' }));

    const result = await xsdValidator.validate(xml);

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/line \d+: .*ruc/);
  });
});

describe('buildAuthorizedXml', () => {
  it('wraps the signed voucher, unchanged, with the authorization of the SRI', () => {
    const voucherXml = '<?xml version="1.0" encoding="UTF-8"?><factura id="comprobante"/>';

    const xml = buildAuthorizedXml({
      number: ACCESS_CODE,
      date: '2026-10-09T10:01:02-05:00',
      environment: 'PRUEBAS',
      voucherXml,
    });

    expect(texts(xml, 'estado')).toEqual(['AUTORIZADO']);
    expect(texts(xml, 'numeroAutorizacion')).toEqual([ACCESS_CODE]);
    expect(texts(xml, 'fechaAutorizacion')).toEqual(['2026-10-09T10:01:02-05:00']);
    expect(texts(xml, 'ambiente')).toEqual(['PRUEBAS']);
    expect(texts(xml, 'comprobante')).toEqual([voucherXml]);
    expect(xml).toContain(`<![CDATA[${voucherXml}]]>`);
  });
});
