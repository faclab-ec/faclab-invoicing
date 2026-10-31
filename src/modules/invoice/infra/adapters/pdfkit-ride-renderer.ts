import bwipjs from 'bwip-js';
import PDFDocument from 'pdfkit';

import { inspectLogo } from '#/modules/company-config/domain/logo';
import { logger } from '#/shared/logger';

import { RideRenderer } from '../../domain/ports';
import { Ride, RideLine } from '../../domain/ride';

type Doc = InstanceType<typeof PDFDocument>;
type Align = 'left' | 'right' | 'center';

// A4 in points
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 28;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;
// Below it only the page number goes
const BOTTOM = PAGE_HEIGHT - MARGIN - 12;
const GAP = 8;
const PAD = 6;
const CELL_PAD = 3;
const FONT = 'Helvetica';
const BOLD = 'Helvetica-Bold';
const TEXT_SIZE = 8;
const TABLE_SIZE = 7.5;
const LOGO_HEIGHT = 70;
const BARCODE_HEIGHT = 36;
const TOTALS_WIDTH = 230;

const COLUMNS: { title: string; width: number; align: Align; cell: (line: RideLine) => string }[] =
  [
    { title: 'Cód. Principal', width: 52, align: 'left', cell: (line) => line.mainCode },
    { title: 'Cód. Auxiliar', width: 52, align: 'left', cell: (line) => line.auxiliaryCode ?? '' },
    { title: 'Cantidad', width: 48, align: 'right', cell: (line) => line.quantity },
    {
      title: 'Descripción',
      width: 211,
      align: 'left',
      cell: (line) => (line.details ? `${line.description}\n${line.details}` : line.description),
    },
    { title: 'Precio Unitario', width: 62, align: 'right', cell: (line) => line.unitPrice },
    { title: 'Descuento', width: 52, align: 'right', cell: (line) => line.discount },
    { title: 'Precio Total', width: 62, align: 'right', cell: (line) => line.total },
  ];

// Characters the standard fonts (WinAnsi) can print besides Latin-1
const WIN_ANSI_EXTRAS = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';

/** The text as the standard fonts can print it: anything else becomes `?` */
export function toWinAnsi(text: string): string {
  return Array.from(text.normalize('NFC'))
    .map((char) => {
      const code = char.codePointAt(0)!;
      if (char === '\n') return char;
      if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return ' ';
      return code <= 0xff || WIN_ANSI_EXTRAS.includes(char) ? char : '?';
    })
    .join('');
}

export interface PdfKitRideRendererOptions {
  // Off only in tests, to read the text of the pages
  compress?: boolean;
}

/**
 * The RIDE as the SRI lays it out: issuer and document side by side (with the access code as a
 * Code 128 barcode), buyer, detail (its header repeated on each page), additional information
 * and payments next to the totals, and the page number.
 */
export class PdfKitRideRenderer implements RideRenderer {
  constructor(private readonly options: PdfKitRideRendererOptions = {}) {}

  async render(ride: Ride, logo: Buffer | null): Promise<Buffer> {
    const barcode = await bwipjs.toBuffer({
      bcid: 'code128',
      text: ride.accessCode,
      scale: 3,
      height: 12,
      includetext: false,
    });
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      bufferPages: true,
      compress: this.options.compress ?? true,
      info: {
        Title: `${ride.documentType} ${ride.documentNumber}`,
        Author: toWinAnsi(ride.issuer.name),
        Subject: `RIDE ${ride.accessCode}`,
        Creator: 'Faclab',
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    let y = this.header(doc, ride, logo, barcode);
    y = this.buyer(doc, ride, y);
    y = this.detail(doc, ride.lines, y);
    this.summary(doc, ride, y);
    this.pageNumbers(doc);
    doc.end();
    return done;
  }

  private header(doc: Doc, ride: Ride, logo: Buffer | null, barcode: Buffer): number {
    const width = (CONTENT_WIDTH - GAP) / 2;
    const left = MARGIN;
    const right = MARGIN + width + GAP;
    const inner = width - 2 * PAD;

    // Left: the logo, then the issuer
    let y = MARGIN;
    if (logo && this.drawLogo(doc, logo, left, y, width)) y += LOGO_HEIGHT + GAP;
    const issuerTop = y;
    const { issuer } = ride;
    y = write(doc, issuer.name, left + PAD, y + PAD, inner, { font: BOLD, size: 10 });
    if (issuer.tradeName && issuer.tradeName !== issuer.name) {
      y = write(doc, issuer.tradeName, left + PAD, y, inner, { size: 9 });
    }
    y = labeled(doc, 'Dirección Matriz', issuer.mainAddress, left + PAD, y + 3, inner);
    if (issuer.branchAddress) {
      y = labeled(doc, 'Dirección Sucursal', issuer.branchAddress, left + PAD, y, inner);
    }
    if (issuer.specialTaxpayer) {
      y = labeled(doc, 'Contribuyente Especial Nro', issuer.specialTaxpayer, left + PAD, y, inner);
    }
    y = labeled(
      doc,
      'OBLIGADO A LLEVAR CONTABILIDAD',
      issuer.accountingRequired,
      left + PAD,
      y,
      inner,
    );
    if (issuer.withholdingAgent) {
      y = labeled(
        doc,
        'Agente de Retención Resolución No.',
        issuer.withholdingAgent,
        left + PAD,
        y,
        inner,
      );
    }
    if (issuer.rimpe) y = write(doc, issuer.rimpe, left + PAD, y, inner, { font: BOLD });
    const leftBottom = y + PAD;

    // Right: the document, its authorization and the access code
    y = labeled(doc, 'R.U.C.', issuer.ruc, right + PAD, MARGIN + PAD, inner, 10);
    y = write(doc, ride.documentType, right + PAD, y + 2, inner, { font: BOLD, size: 13 });
    y = write(doc, `No. ${ride.documentNumber}`, right + PAD, y, inner, { size: 10 });
    y = write(doc, 'NÚMERO DE AUTORIZACIÓN', right + PAD, y + 4, inner, { font: BOLD });
    y = write(doc, ride.authorizationNumber, right + PAD, y, inner);
    y = labeled(doc, 'FECHA Y HORA DE AUTORIZACIÓN', ride.authorizedAt, right + PAD, y + 2, inner);
    y = labeled(doc, 'AMBIENTE', ride.environment, right + PAD, y, inner);
    y = labeled(doc, 'EMISIÓN', ride.emission, right + PAD, y, inner);
    y = write(doc, 'CLAVE DE ACCESO', right + PAD, y + 4, inner, { font: BOLD });
    doc.image(barcode, right + PAD, y + 2, { width: inner, height: BARCODE_HEIGHT });
    y = write(doc, ride.accessCode, right + PAD, y + BARCODE_HEIGHT + 4, inner, {
      size: 7.5,
      align: 'center',
    });
    const rightBottom = y + PAD;

    doc.roundedRect(left, issuerTop, width, leftBottom - issuerTop, 4).stroke();
    doc.roundedRect(right, MARGIN, width, rightBottom - MARGIN, 4).stroke();
    return Math.max(leftBottom, rightBottom) + GAP;
  }

  /** False when the image can't be read: the RIDE goes out without it */
  private drawLogo(doc: Doc, logo: Buffer, x: number, y: number, width: number): boolean {
    // Checked first: pdfkit decodes some PNGs where an error can't be caught
    if (!inspectLogo(logo)) {
      logger.warn('The issuer logo is not an image the RIDE can draw');
      return false;
    }
    try {
      doc.image(logo, x, y, { fit: [width, LOGO_HEIGHT], align: 'center', valign: 'center' });
      return true;
    } catch (error) {
      logger.warn({ err: error }, 'The issuer logo could not be drawn on the RIDE');
      return false;
    }
  }

  private buyer(doc: Doc, ride: Ride, top: number): number {
    const inner = CONTENT_WIDTH - 2 * PAD;
    const { buyer } = ride;
    let y = labeled(
      doc,
      'Razón Social / Nombres y Apellidos',
      buyer.name,
      MARGIN + PAD,
      top + PAD,
      inner,
    );
    y = labeled(doc, 'Identificación', buyer.identification, MARGIN + PAD, y, inner);
    y = labeled(doc, 'Fecha Emisión', buyer.issueDate, MARGIN + PAD, y, inner);
    if (buyer.address) y = labeled(doc, 'Dirección', buyer.address, MARGIN + PAD, y, inner);
    doc.roundedRect(MARGIN, top, CONTENT_WIDTH, y + PAD - top, 4).stroke();
    return y + PAD + GAP;
  }

  private detail(doc: Doc, lines: RideLine[], top: number): number {
    let y = this.detailHeader(doc, top);
    for (const line of lines) {
      const cells = COLUMNS.map((column) => toWinAnsi(column.cell(line)));
      doc.font(FONT).fontSize(TABLE_SIZE);
      const height =
        Math.max(
          ...COLUMNS.map((column, i) =>
            doc.heightOfString(cells[i], { width: column.width - 2 * CELL_PAD }),
          ),
        ) +
        2 * CELL_PAD;
      if (y + height > BOTTOM) {
        doc.addPage();
        y = this.detailHeader(doc, MARGIN);
      }
      let x = MARGIN;
      COLUMNS.forEach((column, i) => {
        doc.rect(x, y, column.width, height).stroke();
        doc.text(cells[i], x + CELL_PAD, y + CELL_PAD, {
          width: column.width - 2 * CELL_PAD,
          align: column.align,
        });
        x += column.width;
      });
      y += height;
    }
    return y + GAP;
  }

  private detailHeader(doc: Doc, y: number): number {
    doc.font(BOLD).fontSize(TABLE_SIZE);
    const height =
      Math.max(
        ...COLUMNS.map((column) =>
          doc.heightOfString(toWinAnsi(column.title), { width: column.width - 2 * CELL_PAD }),
        ),
      ) +
      2 * CELL_PAD;
    let x = MARGIN;
    for (const column of COLUMNS) {
      doc.rect(x, y, column.width, height).fillAndStroke('#eeeeee', '#000000');
      doc.fillColor('#000000').text(toWinAnsi(column.title), x + CELL_PAD, y + CELL_PAD, {
        width: column.width - 2 * CELL_PAD,
        align: 'center',
      });
      x += column.width;
    }
    return y + height;
  }

  /** Additional information and payments on the left, totals on the right, on one page */
  private summary(doc: Doc, ride: Ride, top: number): void {
    const leftWidth = CONTENT_WIDTH - TOTALS_WIDTH - GAP;
    const right = MARGIN + leftWidth + GAP;
    const info = ride.additionalInfo.map((field) => `${field.label}: ${field.value}`);
    const payments = ride.payments.map((payment): [string, string] => [
      payment.term ? `${payment.description} (${payment.term})` : payment.description,
      payment.amount,
    ]);
    const totals = ride.totals.map((row): [string, string] => [row.label, row.value]);

    const height = Math.max(
      this.infoBox(doc, info, MARGIN, top, leftWidth, false) +
        GAP +
        this.table(doc, ['Forma de pago', 'Valor'], payments, MARGIN, 0, leftWidth, false),
      this.table(doc, null, totals, right, 0, TOTALS_WIDTH, false),
    );
    if (top + height > BOTTOM) {
      doc.addPage();
      top = MARGIN;
    }
    const infoHeight = this.infoBox(doc, info, MARGIN, top, leftWidth, true);
    this.table(
      doc,
      ['Forma de pago', 'Valor'],
      payments,
      MARGIN,
      top + infoHeight + GAP,
      leftWidth,
      true,
    );
    this.table(doc, null, totals, right, top, TOTALS_WIDTH, true);
  }

  private infoBox(
    doc: Doc,
    rows: string[],
    x: number,
    top: number,
    width: number,
    draw: boolean,
  ): number {
    const inner = width - 2 * PAD;
    doc.font(BOLD).fontSize(TEXT_SIZE);
    let height = PAD + doc.heightOfString('Información Adicional', { width: inner }) + 2;
    if (draw) write(doc, 'Información Adicional', x + PAD, top + PAD, inner, { font: BOLD });
    for (const row of rows) {
      const text = toWinAnsi(row);
      doc.font(FONT).fontSize(TEXT_SIZE);
      if (draw) doc.text(text, x + PAD, top + height, { width: inner });
      height += doc.heightOfString(text, { width: inner });
    }
    height += PAD;
    if (draw) doc.roundedRect(x, top, width, height, 4).stroke();
    return height;
  }

  /** Two columns, the second right-aligned; with a gray header row when `header` is given */
  private table(
    doc: Doc,
    header: [string, string] | null,
    rows: [string, string][],
    x: number,
    top: number,
    width: number,
    draw: boolean,
  ): number {
    const valueWidth = 70;
    const labelWidth = width - valueWidth;
    let y = top;
    const row = ([label, value]: [string, string], bold: boolean) => {
      doc.font(bold ? BOLD : FONT).fontSize(TABLE_SIZE);
      const cells = [toWinAnsi(label), toWinAnsi(value)];
      const height =
        Math.max(
          doc.heightOfString(cells[0], { width: labelWidth - 2 * CELL_PAD }),
          doc.heightOfString(cells[1], { width: valueWidth - 2 * CELL_PAD }),
        ) +
        2 * CELL_PAD;
      if (draw) {
        if (bold) {
          doc.rect(x, y, width, height).fillAndStroke('#eeeeee', '#000000');
          doc.fillColor('#000000');
        }
        doc.rect(x, y, labelWidth, height).stroke();
        doc.rect(x + labelWidth, y, valueWidth, height).stroke();
        doc.text(cells[0], x + CELL_PAD, y + CELL_PAD, { width: labelWidth - 2 * CELL_PAD });
        doc.text(cells[1], x + labelWidth + CELL_PAD, y + CELL_PAD, {
          width: valueWidth - 2 * CELL_PAD,
          align: 'right',
        });
      }
      y += height;
    };
    if (header) row(header, true);
    for (const cells of rows) row(cells, false);
    return y - top;
  }

  private pageNumbers(doc: Doc): void {
    const { start, count } = doc.bufferedPageRange();
    for (let i = start; i < start + count; i++) {
      doc.switchToPage(i);
      // Below the bottom margin: without this pdfkit would open a new page
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc
        .font(FONT)
        .fontSize(7)
        .text(`Página ${i - start + 1} de ${count}`, MARGIN, PAGE_HEIGHT - MARGIN, {
          width: CONTENT_WIDTH,
          align: 'right',
          lineBreak: false,
        });
      doc.page.margins.bottom = bottomMargin;
    }
  }
}

interface WriteOptions {
  font?: string;
  size?: number;
  align?: Align;
}

/** Writes the text and answers where the next line starts */
function write(
  doc: Doc,
  text: string,
  x: number,
  y: number,
  width: number,
  { font = FONT, size = TEXT_SIZE, align = 'left' }: WriteOptions = {},
): number {
  doc.font(font).fontSize(size).text(toWinAnsi(text), x, y, { width, align });
  return doc.y;
}

/** `Label: value`, the label in bold */
function labeled(
  doc: Doc,
  label: string,
  value: string,
  x: number,
  y: number,
  width: number,
  size: number = TEXT_SIZE,
): number {
  doc
    .font(BOLD)
    .fontSize(size)
    .text(`${toWinAnsi(label)}: `, x, y, { width, continued: true });
  doc.font(FONT).text(toWinAnsi(value));
  return doc.y;
}
