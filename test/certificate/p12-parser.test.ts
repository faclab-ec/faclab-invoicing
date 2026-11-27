import * as forge from 'node-forge';
import { describe, expect, it } from 'vitest';

import { P12ParserAdapter } from '#/modules/certificate/infra/adapters/p12-parser.adapter';
import {
  isCedula,
  MAX_P12_ITERATIONS_PER_KEY,
  P12IterationsError,
  parseP12,
} from '#/shared/infra/p12';

const PASSWORD = 'clave-del-p12';
// One key for every certificate of the file: generating it is the slow part
const keys = forge.pki.rsa.generateKeyPair(1024);

const text = (value: string, type = forge.asn1.Type.UTF8) =>
  forge.asn1.create(forge.asn1.Class.UNIVERSAL, type, false, value);

/** A .p12 like the ones Ecuadorian CAs issue: the id in the subject or in private extensions */
function p12(
  subject: forge.pki.CertificateField[],
  extensions: { id: string; value: forge.asn1.Asn1 }[] = [],
  count = 2048,
): Buffer {
  return Buffer.from(forge.asn1.toDer(p12Asn1(subject, extensions, count)).getBytes(), 'binary');
}

function p12Asn1(
  subject: forge.pki.CertificateField[],
  extensions: { id: string; value: forge.asn1.Asn1 }[] = [],
  count = 2048,
  useMac = true,
): forge.asn1.Asn1 {
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '0a1b';
  cert.validity.notBefore = new Date('2026-01-01T00:00:00Z');
  cert.validity.notAfter = new Date('2028-01-01T00:00:00Z');
  cert.setSubject([{ shortName: 'CN', value: 'JUAN PEREZ' }, ...subject]);
  cert.setIssuer([{ shortName: 'CN', value: 'AUTORIDAD DE CERTIFICACION' }]);
  cert.setExtensions(extensions);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], PASSWORD, {
    algorithm: '3des',
    count,
    useMac,
  });
}

const taxIds = (file: Buffer) => new P12ParserAdapter().parse(file, PASSWORD).taxIds;

describe('P12ParserAdapter tax ids', () => {
  it('reads the RUC and the cédula a CA writes in its own extensions', () => {
    const file = p12(
      [],
      [
        // Like the BCE and Security Data: cédula and RUC under their enterprise number
        { id: '1.3.6.1.4.1.37746.3.1', value: text('1710034065') },
        { id: '1.3.6.1.4.1.37746.3.11', value: text('1792141001001') },
      ],
    );

    expect(taxIds(file)).toEqual(['1710034065', '1792141001001']);
  });

  it('reads the id in the subject: serialNumber and organizationIdentifier', () => {
    const file = p12([
      { type: '2.5.4.5', value: '1710034065' },
      { type: '2.5.4.97', value: 'VATEC-1792141001001' },
    ]);

    expect(taxIds(file).sort()).toEqual(['1710034065', '1792141001001']);
  });

  it('reads a text wrapped in an OCTET STRING or written as PrintableString', () => {
    const wrapped = forge.asn1.create(
      forge.asn1.Class.UNIVERSAL,
      forge.asn1.Type.OCTETSTRING,
      false,
      forge.asn1.toDer(text('RUC: 1792141001001')).getBytes(),
    );
    const file = p12(
      [],
      [
        { id: '1.3.6.1.4.1.47286.102.3.11', value: wrapped },
        { id: '1.3.6.1.4.1.18332.3.1', value: text('1710034065', forge.asn1.Type.PRINTABLESTRING) },
      ],
    );

    expect(taxIds(file)).toEqual(['1792141001001', '1710034065']);
  });

  it('ignores numbers that are neither a RUC nor a cédula, and other extensions', () => {
    const file = p12(
      [{ shortName: 'O', value: 'FERRETERIA 1792141001001' }],
      [
        // A cell phone: ten digits, but not a cédula
        { id: '1.3.6.1.4.1.37746.3.7', value: text('0991234567') },
        // Thirteen digits that don't end in 001
        { id: '1.3.6.1.4.1.37746.3.12', value: text('1792141001002') },
      ],
    );

    expect(taxIds(file)).toEqual([]);
  });
});

describe('parseP12 iteration limits (S9.3)', () => {
  it('refuses a MAC that asks for more iterations than a key may take, without running them', () => {
    const pfx = p12Asn1([]);
    // PFX: version, authSafe, macData (mac, salt, iterations)
    const macData = (pfx.value as forge.asn1.Asn1[])[2];
    (macData.value as forge.asn1.Asn1[])[2].value = forge.asn1
      .integerToDer(2_000_000_000)
      .getBytes();
    const file = Buffer.from(forge.asn1.toDer(pfx).getBytes(), 'binary');

    const started = performance.now();
    expect(() => parseP12(file, PASSWORD)).toThrow(P12IterationsError);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('refuses a file whose derivations add up to more than the limit, each one within it', () => {
    // Without a MAC its contents can be repeated: four encrypted keys, each derived twice (key
    // and IV) with 100k iterations
    const pfx = p12Asn1([], [], 100_000, false);
    // PFX: version, authSafe (contentType, [0] OCTET STRING with the AuthenticatedSafe)
    const octets = ((pfx.value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[])[1]
      .value as forge.asn1.Asn1[];
    const authenticatedSafe = forge.asn1.fromDer(octets[0].value as string);
    const contents = authenticatedSafe.value as forge.asn1.Asn1[];
    contents.push(...contents, ...contents, ...contents);
    octets[0].value = forge.asn1.toDer(authenticatedSafe).getBytes();
    const file = Buffer.from(forge.asn1.toDer(pfx).getBytes(), 'binary');

    expect(() => parseP12(file, PASSWORD)).toThrow(P12IterationsError);
    // node-forge is left as it was
    expect(parseP12(p12([]), PASSWORD).certificate).toBeDefined();
    // It derives keys for real (about a second): more than the default 5 s under a loaded suite
  }, 20_000);

  it('reads the iterations OpenSSL and Java write', () => {
    expect(MAX_P12_ITERATIONS_PER_KEY).toBeGreaterThanOrEqual(10_000);
    expect(parseP12(p12([], [], 10_000), PASSWORD).privateKey).toBeDefined();
  });
});

describe('isCedula', () => {
  it('checks the province, the third digit and the check digit', () => {
    expect(isCedula('1710034065')).toBe(true);
    expect(isCedula('0912345675')).toBe(true);
    expect(isCedula('1710034066')).toBe(false);
    expect(isCedula('0991234567')).toBe(false);
    expect(isCedula('9912345678')).toBe(false);
    expect(isCedula('171003406')).toBe(false);
  });
});
