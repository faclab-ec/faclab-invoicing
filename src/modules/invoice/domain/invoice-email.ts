import { OutgoingMail } from './ports';
import { Ride } from './ride';

export interface InvoiceEmailInput {
  ride: Ride;
  // The authorized XML and the RIDE, as they are kept
  authorizedXml: Buffer;
  pdf: Buffer;
  // The platform's address; the issuer's name goes with it
  from: string;
  // The issuer's email, when it has one
  replyTo: string | null;
  to: string;
}

const TEST_NOTE = 'Comprobante emitido en el ambiente de pruebas del SRI, sin validez tributaria.';

/** The email that carries an authorized invoice to its buyer: XML and RIDE attached */
export function buildInvoiceEmail(input: InvoiceEmailInput): OutgoingMail {
  const { ride } = input;
  const issuer = ride.issuer.tradeName ?? ride.issuer.name;
  const prefix = ride.isTest ? '[PRUEBAS] ' : '';
  const details: [string, string][] = [
    ['Factura No.', ride.documentNumber],
    ['Fecha de emisión', ride.buyer.issueDate],
    ['Valor total', `USD ${ride.total}`],
    ['Clave de acceso', ride.accessCode],
    ['Número de autorización', ride.authorizationNumber],
  ];
  const paragraphs = [
    `Estimado/a ${ride.buyer.name}:`,
    `${issuer} le envía su factura electrónica.`,
    'Adjuntamos el comprobante autorizado por el SRI (XML) y su representación impresa (RIDE, en PDF).',
    ...(ride.isTest ? [TEST_NOTE] : []),
    input.replyTo
      ? 'Si tiene alguna consulta, responda a este correo.'
      : 'Este correo se envía automáticamente; por favor no lo responda.',
  ];

  const text = [
    paragraphs[0],
    '',
    paragraphs[1],
    '',
    ...details.map(([label, value]) => `${label}: ${value}`),
    '',
    ...paragraphs.slice(2).flatMap((paragraph) => [paragraph, '']),
  ]
    .join('\n')
    .trimEnd();
  const html = [
    `<p>${escapeHtml(paragraphs[0])}</p>`,
    `<p>${escapeHtml(paragraphs[1])}</p>`,
    '<table>',
    ...details.map(
      ([label, value]) =>
        `<tr><td><strong>${escapeHtml(label)}:</strong></td><td>${escapeHtml(value)}</td></tr>`,
    ),
    '</table>',
    ...paragraphs.slice(2).map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`),
  ].join('\n');

  return {
    from: { name: issuer, address: input.from },
    replyTo: input.replyTo,
    to: input.to,
    subject: `${prefix}Factura electrónica No. ${ride.documentNumber} de ${issuer}`,
    text,
    html,
    attachments: [
      {
        filename: `${ride.accessCode}.xml`,
        content: input.authorizedXml,
        contentType: 'application/xml',
      },
      { filename: `${ride.accessCode}.pdf`, content: input.pdf, contentType: 'application/pdf' },
    ],
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
