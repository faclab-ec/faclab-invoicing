import { describe, expect, it } from 'vitest';

import { inspectLogo, issuerLogoKey } from '#/modules/company-config/domain/logo';

import { TENANT_A } from '../helpers';
import { makePng } from '../pdf-text';

/** A JPEG header up to its start of frame: enough to know its size */
function jpegHeader(width: number, height: number): Buffer {
  const app0 = Buffer.from([
    0xff,
    0xe0,
    0x00,
    0x10,
    ...Buffer.from('JFIF\0'),
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
  ]);
  const sof = Buffer.alloc(19);
  sof.set([0xff, 0xc0, 0x00, 0x11, 0x08]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

describe('inspectLogo: only PNG and JPEG images the RIDE can draw', () => {
  it('reads the type and size of a PNG, decoding it completely', () => {
    expect(inspectLogo(makePng(40, 20))).toEqual({
      contentType: 'image/png',
      width: 40,
      height: 20,
    });
  });

  it('reads the type and size of a JPEG', () => {
    expect(inspectLogo(jpegHeader(300, 120))).toEqual({
      contentType: 'image/jpeg',
      width: 300,
      height: 120,
    });
  });

  it('refuses images over 2000 pixels on a side', () => {
    expect(inspectLogo(makePng(2001, 1))).toBeNull();
    expect(inspectLogo(jpegHeader(800, 2400))).toBeNull();
  });

  it('refuses a PNG whose pixels do not decode', () => {
    const png = makePng(40, 20);
    const idat = png.indexOf('IDAT', 0, 'latin1');
    const corrupt = Buffer.from(png);
    corrupt.fill(0x7f, idat + 6, idat + 20);

    expect(inspectLogo(corrupt)).toBeNull();
    expect(inspectLogo(makePng(4, 4, 9))).toBeNull();
    expect(inspectLogo(png.subarray(0, png.length - 12))).toBeNull();
  });

  it('refuses an interlaced PNG', () => {
    const png = makePng(4, 4);
    // IHDR data starts after the signature (8), its length (4) and its type (4); interlace is byte 12
    png[8 + 8 + 12] = 1;

    expect(inspectLogo(png)).toBeNull();
  });

  it('refuses anything else', () => {
    expect(inspectLogo(Buffer.from('GIF89a'))).toBeNull();
    expect(inspectLogo(Buffer.from('<svg/>'))).toBeNull();
    expect(inspectLogo(Buffer.alloc(0))).toBeNull();
  });

  it('keeps one logo per company', () => {
    expect(issuerLogoKey(TENANT_A)).toBe(`tenants/${TENANT_A}/issuer/logo`);
  });
});
