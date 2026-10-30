import { inflateSync } from 'zlib';

export const LOGO_MAX_BYTES = 300 * 1024;
// Larger images would only weigh down the RIDE (and could inflate to a lot of memory)
export const LOGO_MAX_PIXELS = 2000;

export type LogoContentType = 'image/png' | 'image/jpeg';

export interface LogoInfo {
  contentType: LogoContentType;
  width: number;
  height: number;
}

/** Where the logos are kept: the object storage of the documents */
export interface LogoStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  getBytes(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

/** Where the logo of a company's issuer is kept: one per company, replaced on each upload */
export function issuerLogoKey(tenantId: string): string {
  return `tenants/${tenantId}/issuer/logo`;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Channels of each PNG color type: gray, RGB, palette, gray + alpha, RGBA
const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * What the logo is, or null when it isn't a PNG or JPEG the RIDE can draw. A PNG is decoded
 * completely: the PDF library decodes PNGs with transparency in a callback, where a corrupt image
 * would throw outside any try/catch.
 */
export function inspectLogo(bytes: Buffer): LogoInfo | null {
  try {
    if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return inspectPng(bytes);
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return inspectJpeg(bytes);
  } catch {
    return null;
  }
  return null;
}

function inspectPng(bytes: Buffer): LogoInfo | null {
  let width = 0;
  let height = 0;
  let bitsPerPixel = 0;
  const data: Buffer[] = [];
  let ended = false;
  for (let pos = 8; pos + 8 <= bytes.length && !ended; ) {
    const length = bytes.readUInt32BE(pos);
    const type = bytes.toString('latin1', pos + 4, pos + 8);
    const chunk = bytes.subarray(pos + 8, pos + 8 + length);
    if (chunk.length !== length) return null;
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      const bitDepth = chunk[8];
      const channels = PNG_CHANNELS[chunk[9]];
      // Interlaced images aren't supported: re-save the logo without interlacing
      if (!channels || chunk[12] !== 0) return null;
      bitsPerPixel = bitDepth * channels;
    } else if (type === 'IDAT') {
      data.push(chunk);
    } else if (type === 'IEND') {
      ended = true;
    }
    pos += 12 + length;
  }
  if (!ended || !fits(width, height) || bitsPerPixel === 0 || data.length === 0) return null;

  // Each row: its filter type (0 to 4), then its pixels
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  const pixels = inflateSync(Buffer.concat(data));
  if (pixels.length !== height * (rowBytes + 1)) return null;
  for (let row = 0; row < height; row++) {
    if (pixels[row * (rowBytes + 1)] > 4) return null;
  }
  return { contentType: 'image/png', width, height };
}

// Start of frame markers (baseline, progressive, …): they carry the dimensions
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce]);

function inspectJpeg(bytes: Buffer): LogoInfo | null {
  for (let pos = 2; pos + 4 <= bytes.length; ) {
    if (bytes[pos] !== 0xff) return null;
    const marker = bytes[pos + 1];
    const length = bytes.readUInt16BE(pos + 2);
    if (JPEG_SOF.has(marker)) {
      const height = bytes.readUInt16BE(pos + 5);
      const width = bytes.readUInt16BE(pos + 7);
      return fits(width, height) ? { contentType: 'image/jpeg', width, height } : null;
    }
    pos += 2 + length;
  }
  return null;
}

function fits(width: number, height: number): boolean {
  return width > 0 && height > 0 && width <= LOGO_MAX_PIXELS && height <= LOGO_MAX_PIXELS;
}
