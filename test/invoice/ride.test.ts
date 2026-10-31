import { describe, expect, it } from 'vitest';

import { buildRide } from '#/modules/invoice/domain/ride';

import { signedInvoiceXml, TEST_ACCESS_CODE, TEST_AUTHORIZATION } from '../helpers';

const TIMEZONE = 'America/Guayaquil';

describe('buildRide: what the RIDE prints, from the authorized XML', () => {
  const ride = buildRide(signedInvoiceXml(), TEST_AUTHORIZATION, TIMEZONE);

  it('prints the issuer with its legends', () => {
    expect(ride.issuer).toEqual({
      name: 'Ferretería ACME S.A.',
      tradeName: 'ACME',
      ruc: '1792141001001',
      mainAddress: 'Av. 10 de Agosto N25-34, Quito',
      branchAddress: 'Av. Amazonas N34-120, Quito',
      specialTaxpayer: '5368',
      accountingRequired: 'SI',
      withholdingAgent: '12345678',
      rimpe: 'CONTRIBUYENTE RÉGIMEN RIMPE',
    });
  });

  it('prints the document, its authorization and the access code', () => {
    expect(ride).toMatchObject({
      documentType: 'FACTURA',
      documentNumber: '001-001-000000001',
      authorizationNumber: TEST_ACCESS_CODE,
      // 15:01:02 UTC in Ecuador
      authorizedAt: '09/10/2026 10:01:02',
      environment: 'PRUEBAS',
      isTest: true,
      emission: 'NORMAL',
      accessCode: TEST_ACCESS_CODE,
    });
  });

  it('prints the buyer and the emission date', () => {
    expect(ride.buyer).toEqual({
      name: 'Construcciones Andinas Cía. Ltda.',
      identification: '1790012345001',
      address: null,
      issueDate: '09/10/2026',
    });
  });

  it('prints each line with at least two decimals and its full unit price', () => {
    expect(ride.lines).toEqual([
      {
        mainCode: '7',
        auxiliaryCode: 'CEM-50',
        description: 'Cemento Portland 50 kg',
        details: null,
        quantity: '10.00',
        unitPrice: '8.50',
        discount: '4.25',
        total: '80.75',
      },
      {
        mainCode: '8',
        auxiliaryCode: 'VAR-12',
        description: 'Varilla corrugada 12 mm',
        details: null,
        quantity: '2.50',
        unitPrice: '3.456789',
        discount: '0.00',
        total: '8.64',
      },
      {
        mainCode: '9',
        auxiliaryCode: null,
        description: 'Corte de varilla',
        details: null,
        quantity: '1.00',
        unitPrice: '5.00',
        discount: '0.00',
        total: '5.00',
      },
    ]);
  });

  it('prints the totals the SRI asks for, by rate', () => {
    expect(ride.totals).toEqual([
      { label: 'SUBTOTAL 15%', value: '80.75' },
      { label: 'SUBTOTAL 0%', value: '8.64' },
      { label: 'SUBTOTAL NO OBJETO DE IVA', value: '5.00' },
      { label: 'SUBTOTAL EXENTO DE IVA', value: '0.00' },
      { label: 'SUBTOTAL SIN IMPUESTOS', value: '94.39' },
      { label: 'TOTAL DESCUENTO', value: '4.25' },
      { label: 'IVA 15%', value: '12.11' },
      { label: 'PROPINA', value: '0.00' },
      { label: 'VALOR TOTAL', value: '106.50' },
    ]);
    expect(ride.total).toBe('106.50');
  });

  it('prints the payments with the names of Tabla 24', () => {
    expect(ride.payments).toEqual([
      { description: 'SIN UTILIZACIÓN DEL SISTEMA FINANCIERO', amount: '50.00', term: null },
      { description: 'TARJETA DE CRÉDITO', amount: '56.50', term: null },
    ]);
  });

  it('prints the additional information', () => {
    expect(ride.additionalInfo).toEqual([
      { label: 'Dirección', value: 'Av. 6 de Diciembre N24-253, Quito' },
      { label: 'Telefono', value: '022345678' },
      { label: 'Email', value: 'compras@construccionesandinas.ec' },
      { label: 'RUC Proveedor', value: '0990012345001' },
    ]);
  });

  it('adds the subtotal and IVA of any other rate the invoice has', () => {
    const fivePercent = buildRide(
      signedInvoiceXml({
        environment: 2,
        total: 10.5,
        payments: [{ formaPago: '20', amount: 10.5 }],
        items: [
          {
            productId: '1',
            sku: null,
            description: 'Tour',
            quantity: 1,
            unitPrice: 10,
            discount: 0,
            taxableBase: 10,
            taxCode: 5,
            taxRate: 5,
            taxAmount: 0.5,
          },
        ],
      }),
      TEST_AUTHORIZATION,
      TIMEZONE,
    );

    expect(fivePercent.totals.map((row) => `${row.label} ${row.value}`)).toEqual([
      'SUBTOTAL 15% 0.00',
      'SUBTOTAL 0% 0.00',
      'SUBTOTAL 5% 10.00',
      'SUBTOTAL NO OBJETO DE IVA 0.00',
      'SUBTOTAL EXENTO DE IVA 0.00',
      'SUBTOTAL SIN IMPUESTOS 10.00',
      'TOTAL DESCUENTO 0.00',
      'IVA 15% 0.00',
      'IVA 5% 0.50',
      'PROPINA 0.00',
      'VALOR TOTAL 10.50',
    ]);
    expect(fivePercent).toMatchObject({ environment: 'PRODUCCIÓN', isTest: false });
  });

  it('leaves out the legends the issuer does not have', () => {
    const plain = buildRide(
      signedInvoiceXml({
        companySpecialTaxpayerResolution: null,
        companyWithholdingAgentResolution: null,
        companyRimpeRegime: null,
        companyAccountingRequired: false,
        companyBranchAddress: null,
      }),
      TEST_AUTHORIZATION,
      TIMEZONE,
    );

    expect(plain.issuer).toMatchObject({
      specialTaxpayer: null,
      withholdingAgent: null,
      rimpe: null,
      accountingRequired: 'NO',
      branchAddress: null,
    });
  });

  it('ignores the XAdES signature inside the invoice', () => {
    const signature =
      '<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="Signature1">' +
      '<ds:SignedInfo><ds:Reference URI="#comprobante"><ds:DigestValue>abc</ds:DigestValue>' +
      '</ds:Reference></ds:SignedInfo><ds:Object><detalles><detalle/></detalles></ds:Object>' +
      '</ds:Signature>';
    const xml = signedInvoiceXml().replace('</factura>', `${signature}</factura>`);

    expect(buildRide(xml, TEST_AUTHORIZATION, TIMEZONE)).toEqual(ride);
  });

  it('refuses what is not an invoice XML', () => {
    expect(() => buildRide('<notaCredito/>', TEST_AUTHORIZATION, TIMEZONE)).toThrow(
      'Not an invoice XML',
    );
    expect(() => buildRide('<factura', TEST_AUTHORIZATION, TIMEZONE)).toThrow('Not an invoice');
  });
});
