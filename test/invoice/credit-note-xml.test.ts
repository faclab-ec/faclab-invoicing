import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';

import { RimpeRegime } from '#/modules/company-config/domain/company-config';
import { VoucherType } from '#/modules/company-config/domain/sequence';
import {
  buildCreditNoteXml,
  CreditNoteXmlInput,
} from '#/modules/invoice/domain/credit-note-xml-builder';

import { RUC_A, RUC_B, xsdValidator } from '../helpers';

const ACCESS_CODE = '0910202604179214100100110010010000000011234567819';

function input(overrides: Partial<CreditNoteXmlInput> = {}): CreditNoteXmlInput {
  return {
    environment: 1,
    emissionType: 1,
    companyName: 'Ferretería ACME S.A.',
    companyTradeName: 'ACME',
    companyCode: RUC_A,
    companyMainAddress: 'Av. 10 de Agosto N25-34, Quito',
    companyBranchAddress: 'Av. Amazonas N34-120, Quito',
    companyBranchCode: '001',
    companySalePointCode: '002',
    companyAccountingRequired: true,
    companySpecialTaxpayerResolution: null,
    companyWithholdingAgentResolution: null,
    companyRimpeRegime: null,
    providerRuc: null,
    accessCode: ACCESS_CODE,
    sequence: '000000012',
    voucherTypeCode: VoucherType.CREDIT_NOTE,
    date: new Date('2026-10-09T15:00:00Z'),
    customer: {
      taxIdCode: '04',
      name: 'Construcciones Andinas Cía. Ltda.',
      taxId: '1790012345001',
    },
    modifiedNumber: '001-001-000000123',
    modifiedDate: '05/10/2026',
    reason: 'Producto con defecto de fábrica',
    items: [
      {
        productId: '7',
        sku: 'CEM-50',
        description: 'Cemento Portland 50 kg',
        quantity: 2,
        unitPrice: 8.5,
        discount: 0.85,
        taxableBase: 16.15,
        taxCode: 4,
        taxRate: 15,
        taxAmount: 2.42,
      },
      {
        productId: '8',
        sku: null,
        description: 'Abono orgánico',
        quantity: 1,
        unitPrice: 6,
        discount: 0,
        taxableBase: 6,
        taxCode: 0,
        taxRate: 0,
        taxAmount: 0,
      },
    ],
    ...overrides,
  };
}

const parse = (xml: string) => new DOMParser().parseFromString(xml, 'text/xml');
const texts = (xml: string, tag: string) =>
  Array.from(parse(xml).getElementsByTagName(tag)).map((node) => node.textContent);
const text = (xml: string, tag: string) => texts(xml, tag)[0];

async function expectValid(xml: string) {
  expect(await xsdValidator.validate(xml, VoucherType.CREDIT_NOTE)).toEqual({
    valid: true,
    errors: [],
  });
}

describe('buildCreditNoteXml: the notaCredito 1.1.0 of the SRI', () => {
  it('passes the XSD and says codDoc 04, with the signer id', async () => {
    const xml = buildCreditNoteXml(input());

    await expectValid(xml);
    const root = parse(xml).documentElement!;
    expect(root.localName).toBe('notaCredito');
    expect(root.getAttribute('id')).toBe('comprobante');
    expect(root.getAttribute('version')).toBe('1.1.0');
    expect(text(xml, 'codDoc')).toBe('04');
    expect(text(xml, 'claveAcceso')).toBe(ACCESS_CODE);
    expect(text(xml, 'estab')).toBe('001');
    expect(text(xml, 'ptoEmi')).toBe('002');
    expect(text(xml, 'secuencial')).toBe('000000012');
  });

  it('credits a decimal quantity as decimal text the XSD takes (S5.1)', async () => {
    const [line] = input().items;
    const xml = buildCreditNoteXml(
      input({
        items: [
          {
            ...line,
            quantity: '1.250000',
            unitPrice: '0.850000',
            discount: 0,
            taxableBase: 1.06,
            taxAmount: 0.16,
          },
        ],
      }),
    );

    await expectValid(xml);
    expect(texts(xml, 'cantidad')).toEqual(['1.25']);
    expect(texts(xml, 'precioUnitario')).toEqual(['0.85']);
  });

  it('refers to the invoice it modifies, with its reason', () => {
    const xml = buildCreditNoteXml(input());

    expect(text(xml, 'codDocModificado')).toBe('01');
    expect(text(xml, 'numDocModificado')).toBe('001-001-000000123');
    expect(text(xml, 'fechaEmisionDocSustento')).toBe('05/10/2026');
    expect(text(xml, 'fechaEmision')).toBe('09/10/2026');
    expect(text(xml, 'motivo')).toBe('Producto con defecto de fábrica');
  });

  it('adds up its totals in cents from the lines, by rate', async () => {
    const xml = buildCreditNoteXml(input());

    await expectValid(xml);
    expect(text(xml, 'totalSinImpuestos')).toBe('22.15');
    expect(text(xml, 'valorModificacion')).toBe('24.57');
    expect(text(xml, 'moneda')).toBe('DOLAR');
    const groups = Array.from(parse(xml).getElementsByTagName('totalImpuesto')).map((node) =>
      ['codigoPorcentaje', 'baseImponible', 'valor'].map(
        (tag) => node.getElementsByTagName(tag)[0].textContent,
      ),
    );
    expect(groups).toEqual([
      ['4', '16.15', '2.42'],
      ['0', '6.00', '0.00'],
    ]);
  });

  it('writes its lines with the tags of a credit note', async () => {
    const xml = buildCreditNoteXml(input());

    await expectValid(xml);
    expect(texts(xml, 'codigoInterno')).toEqual(['7', '8']);
    expect(texts(xml, 'codigoAdicional')).toEqual(['CEM-50']);
    expect(texts(xml, 'codigoPrincipal')).toEqual([]);
    expect(texts(xml, 'descuento')).toEqual(['0.85', '0.00']);
    expect(texts(xml, 'precioTotalSinImpuesto')).toEqual(['16.15', '6.00']);
  });

  it('writes the code of a construction material in codigoAdicional, instead of the SKU', async () => {
    const [cement, other] = input().items;
    const xml = buildCreditNoteXml(
      input({ items: [{ ...cement, constructionMaterialCode: 'F010401' }, other] }),
    );

    await expectValid(xml);
    expect(texts(xml, 'codigoAdicional')).toEqual(['F010401']);
    expect(texts(xml, 'codigoInterno')).toEqual(['7', '8']);
  });

  it.each([
    ['RUC', '04', '1790012345001'],
    ['cédula', '05', '1712345678'],
    ['pasaporte', '06', 'AB123456'],
    ['identificación del exterior', '08', 'EX-998877'],
  ])('passes the XSD with a buyer identified by %s', async (_name, taxIdCode, taxId) => {
    const xml = buildCreditNoteXml(input({ customer: { taxIdCode, name: 'Comprador', taxId } }));

    await expectValid(xml);
    expect(text(xml, 'tipoIdentificacionComprador')).toBe(taxIdCode);
    expect(text(xml, 'identificacionComprador')).toBe(taxId);
  });

  it.each([
    ['Emprendedor', RimpeRegime.ENTREPRENEUR, 'CONTRIBUYENTE RÉGIMEN RIMPE'],
    [
      'Negocio Popular',
      RimpeRegime.POPULAR_BUSINESS,
      'CONTRIBUYENTE NEGOCIO POPULAR - RÉGIMEN RIMPE',
    ],
  ])('carries the legends of the issuer, also RIMPE %s', async (_name, regime, legend) => {
    const xml = buildCreditNoteXml(
      input({
        companySpecialTaxpayerResolution: '5368',
        companyWithholdingAgentResolution: '12345678',
        companyRimpeRegime: regime,
        providerRuc: RUC_B,
      }),
    );

    await expectValid(xml);
    expect(text(xml, 'contribuyenteEspecial')).toBe('5368');
    expect(text(xml, 'agenteRetencion')).toBe('12345678');
    expect(text(xml, 'contribuyenteRimpe')).toBe(legend);
    expect(texts(xml, 'campoAdicional')).toEqual([RUC_B]);
  });

  it('leaves out what the schema does not admit empty', async () => {
    const xml = buildCreditNoteXml(
      input({
        companyBranchAddress: null,
        items: [
          {
            ...input().items[0],
            // Over the 25 characters of codigoAdicional
            sku: 'X'.repeat(26),
          },
        ],
      }),
    );

    await expectValid(xml);
    expect(texts(xml, 'dirEstablecimiento')).toEqual([]);
    expect(texts(xml, 'codigoAdicional')).toEqual([]);
    expect(texts(xml, 'infoAdicional')).toEqual([]);
  });

  it('fits a long reason with line breaks in the one line of 300 the schema takes', async () => {
    const xml = buildCreditNoteXml(input({ reason: `Devolución\n${'x'.repeat(400)}` }));

    await expectValid(xml);
    expect(text(xml, 'motivo')).toHaveLength(300);
    expect(text(xml, 'motivo')).not.toContain('\n');
  });

  it("isn't valid against the invoice's schema: each type has its own", async () => {
    const result = await xsdValidator.validate(buildCreditNoteXml(input()), VoucherType.INVOICE);

    expect(result.valid).toBe(false);
  });
});
