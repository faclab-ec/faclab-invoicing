import { crc32, deflateSync } from 'zlib';

// WinAnsi (Windows-1252) between 0x80 and 0x9f; the rest is Latin-1. Node's TextDecoder
// decodes that range as Latin-1 control characters
const WIN_ANSI_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';

const winAnsiChar = (code: number) =>
  code >= 0x80 && code <= 0x9f ? WIN_ANSI_HIGH[code - 0x80] : String.fromCharCode(code);

/**
 * The text of an uncompressed PDF made by pdfkit with its standard fonts, one entry per text run
 * (`[<hex> kerning <hex> …] TJ`), in drawing order. Each hex digit pair is a WinAnsi character.
 */
export function pdfTextRuns(pdf: Buffer): string[] {
  const runs: string[] = [];
  for (const [, array] of pdf.toString('latin1').matchAll(/\[([^\]]*)\] TJ/g)) {
    const hex = [...array.matchAll(/<([0-9a-f]*)>/g)].map(([, segment]) => segment).join('');
    runs.push((hex.match(/../g) ?? []).map((pair) => winAnsiChar(parseInt(pair, 16))).join(''));
  }
  return runs;
}

/** All the text of the PDF, its runs joined by line breaks */
export const pdfText = (pdf: Buffer) => pdfTextRuns(pdf).join('\n');

/** How many pages the PDF has */
export const pdfPageCount = (pdf: Buffer) =>
  (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;

/** How many images (logo, barcode) the PDF embeds */
export const pdfImageCount = (pdf: Buffer) =>
  (pdf.toString('latin1').match(/\/Subtype \/Image\b/g) ?? []).length;

/**
 * A PNG of `width` × `height` red pixels with transparency (RGBA), as a logo; valid unless `filter`
 * (the filter type of each row) is over 4
 */
export function makePng(width: number, height: number, filter: number = 0): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const row = Buffer.concat([
    Buffer.from([filter]),
    Buffer.alloc(width * 4, Buffer.from([255, 0, 0, 200])),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array(height).fill(row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const LOGO_PNG = makePng(40, 20);
