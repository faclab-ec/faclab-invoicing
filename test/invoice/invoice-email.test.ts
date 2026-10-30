import { describe, expect, it } from 'vitest';

import { buildInvoiceEmail } from '#/modules/invoice/domain/invoice-email';
import { buildRide } from '#/modules/invoice/domain/ride';

import { signedInvoiceXml, TEST_ACCESS_CODE, TEST_AUTHORIZATION } from '../helpers';

const rideOf = (environment: number, buyer = 'Construcciones Andinas Cía. Ltda.') =>
  buildRide(
    signedInvoiceXml({
      environment,
      customer: { taxIdCode: '04', name: buyer, taxId: '1790012345001' },
    }),
    TEST_AUTHORIZATION,
    'America/Guayaquil',
  );

const email = (environment = 2, replyTo: string | null = 'ventas@acme.ec', buyer?: string) =>
  buildInvoiceEmail({
    ride: rideOf(environment, buyer),
    authorizedXml: Buffer.from('<autorizacion/>'),
    pdf: Buffer.from('%PDF-1.3'),
    from: 'facturas@faclab.test',
    replyTo,
    to: 'compras@andinas.ec',
  });

describe('buildInvoiceEmail', () => {
  it('comes from the issuer, answers to it and carries the XML and the RIDE', () => {
    const mail = email();

    expect(mail.from).toEqual({ name: 'ACME', address: 'facturas@faclab.test' });
    expect(mail.replyTo).toBe('ventas@acme.ec');
    expect(mail.to).toBe('compras@andinas.ec');
    expect(mail.subject).toBe('Factura electrónica No. 001-001-000000001 de ACME');
    expect(mail.attachments.map(({ filename, contentType }) => [filename, contentType])).toEqual([
      [`${TEST_ACCESS_CODE}.xml`, 'application/xml'],
      [`${TEST_ACCESS_CODE}.pdf`, 'application/pdf'],
    ]);
    for (const value of [
      'Estimado/a Construcciones Andinas Cía. Ltda.:',
      'Factura No.: 001-001-000000001',
      'Valor total: USD 106.50',
      `Clave de acceso: ${TEST_ACCESS_CODE}`,
      'Si tiene alguna consulta, responda a este correo.',
    ]) {
      expect(mail.text).toContain(value);
    }
    expect(mail.text).not.toContain('pruebas');
  });

  it('says it has no tax validity when it was issued in the testing environment', () => {
    const mail = email(1);

    expect(mail.subject).toBe('[PRUEBAS] Factura electrónica No. 001-001-000000001 de ACME');
    expect(mail.text).toContain('ambiente de pruebas del SRI, sin validez tributaria');
    expect(mail.html).toContain('sin validez tributaria');
  });

  it('asks not to answer when the issuer has no email', () => {
    expect(email(2, null).text).toContain('por favor no lo responda');
  });

  it('escapes the names in its HTML', () => {
    const mail = email(2, null, 'Ferretería <b>"La Llave"</b> & Cía');

    expect(mail.html).toContain('Ferretería &lt;b&gt;&quot;La Llave&quot;&lt;/b&gt; &amp; Cía');
    expect(mail.html).not.toContain('<b>');
  });
});
