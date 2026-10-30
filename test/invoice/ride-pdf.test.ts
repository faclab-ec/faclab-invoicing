import { describe, expect, it } from 'vitest';

import { buildRide, Ride } from '#/modules/invoice/domain/ride';
import {
  PdfKitRideRenderer,
  toWinAnsi,
} from '#/modules/invoice/infra/adapters/pdfkit-ride-renderer';

import { fullInvoiceXmlInput, signedInvoiceXml, TEST_AUTHORIZATION } from '../helpers';
import { LOGO_PNG, makePng, pdfImageCount, pdfPageCount, pdfText, pdfTextRuns } from '../pdf-text';

const renderer = new PdfKitRideRenderer({ compress: false });
const rideOf = (xml: string = signedInvoiceXml()): Ride =>
  buildRide(xml, TEST_AUTHORIZATION, 'America/Guayaquil');

describe('PdfKitRideRenderer: the RIDE as a PDF', () => {
  it('prints every field the SRI requires', async () => {
    const ride = rideOf();
    const pdf = await renderer.render(ride, LOGO_PNG);
    const text = pdfText(pdf);

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const expected = [
      // Issuer
      'Ferretería ACME S.A.',
      'ACME',
      'Dirección Matriz:',
      'Av. 10 de Agosto N25-34, Quito',
      'Dirección Sucursal:',
      'Av. Amazonas N34-120, Quito',
      'Contribuyente Especial Nro:',
      '5368',
      'OBLIGADO A LLEVAR CONTABILIDAD:',
      'Agente de Retención Resolución No.:',
      '12345678',
      'CONTRIBUYENTE RÉGIMEN RIMPE',
      // Document and authorization
      'R.U.C.:',
      '1792141001001',
      'FACTURA',
      'No. 001-001-000000001',
      'NÚMERO DE AUTORIZACIÓN',
      'FECHA Y HORA DE AUTORIZACIÓN:',
      '09/10/2026 10:01:02',
      'AMBIENTE:',
      'PRUEBAS',
      'EMISIÓN:',
      'NORMAL',
      'CLAVE DE ACCESO',
      ride.accessCode,
      // Buyer
      'Razón Social / Nombres y Apellidos:',
      'Construcciones Andinas Cía. Ltda.',
      'Identificación:',
      '1790012345001',
      'Fecha Emisión:',
      '09/10/2026',
      // Detail
      'Cantidad',
      'Descripción',
      'Precio Unitario',
      'Descuento',
      'Precio Total',
      'CEM-50',
      'Cemento Portland 50 kg',
      '3.456789',
      '80.75',
      // Additional information, payments, totals
      'Información Adicional',
      'Email: compras@construccionesandinas.ec',
      'Forma de pago',
      'SIN UTILIZACIÓN DEL SISTEMA FINANCIERO',
      'TARJETA DE CRÉDITO',
      'SUBTOTAL 15%',
      'SUBTOTAL 0%',
      'SUBTOTAL NO OBJETO DE IVA',
      'SUBTOTAL EXENTO DE IVA',
      'SUBTOTAL SIN IMPUESTOS',
      'TOTAL DESCUENTO',
      'IVA 15%',
      'PROPINA',
      'VALOR TOTAL',
      '106.50',
      'Página 1 de 1',
    ];
    for (const value of expected) expect(text).toContain(value);
    // The authorization number and the access code (under its barcode)
    expect(pdfTextRuns(pdf).filter((run) => run === ride.accessCode)).toHaveLength(2);
  });

  it('draws the access code as a barcode, and the logo when there is one', async () => {
    const withoutLogo = pdfImageCount(await renderer.render(rideOf(), null));
    const withLogo = pdfImageCount(await renderer.render(rideOf(), LOGO_PNG));

    expect(withoutLogo).toBeGreaterThanOrEqual(1);
    expect(withLogo).toBeGreaterThan(withoutLogo);
  });

  it('goes out without a logo it cannot draw', async () => {
    const withoutLogo = pdfImageCount(await renderer.render(rideOf(), null));
    const corrupt = Buffer.from(LOGO_PNG);
    corrupt.fill(0x7f, corrupt.indexOf('IDAT', 0, 'latin1') + 6);

    for (const logo of [Buffer.from('not an image'), corrupt, makePng(4, 4, 9)]) {
      const pdf = await renderer.render(rideOf(), logo);
      expect(pdfImageCount(pdf)).toBe(withoutLogo);
      expect(pdfText(pdf)).toContain('VALOR TOTAL');
    }
  });

  it('repeats the detail header on every page of a long invoice', async () => {
    const line = fullInvoiceXmlInput().items[0];
    const items = Array.from({ length: 60 }, (_, i) => ({
      ...line,
      productId: String(i + 1),
      description: `Producto ${i + 1} con una descripción larga que ocupa más de una línea en el RIDE`,
    }));
    const total = items.reduce((sum, item) => sum + item.taxableBase + item.taxAmount, 0);
    const xml = signedInvoiceXml({
      items,
      total,
      payments: [{ formaPago: '20', amount: total }],
    });
    const pdf = await renderer.render(rideOf(xml), null);
    const pages = pdfPageCount(pdf);

    expect(pages).toBeGreaterThan(1);
    expect(pdfTextRuns(pdf).filter((run) => run === 'Descripción')).toHaveLength(pages);
    expect(pdfText(pdf)).toContain(`Página ${pages} de ${pages}`);
    expect(pdfText(pdf)).toContain('Producto 60 con una descripción larga');
  });

  it('prints what its fonts cannot with a question mark', async () => {
    const pdf = await renderer.render(
      rideOf(
        signedInvoiceXml({
          items: [{ ...fullInvoiceXmlInput().items[0], description: 'Taladro 😀 “Pro” 中' }],
          total: 92.86,
          payments: [{ formaPago: '01', amount: 92.86 }],
        }),
      ),
      null,
    );

    expect(pdfText(pdf)).toContain('Taladro ? “Pro” ?');
  });
});

describe('toWinAnsi', () => {
  it('keeps Spanish and WinAnsi punctuation, replaces the rest', () => {
    expect(toWinAnsi('Ñandú – “ok” €5 ✓\tfin')).toBe('Ñandú – “ok” €5 ? fin');
  });
});
