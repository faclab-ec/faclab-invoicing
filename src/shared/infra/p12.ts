import * as forge from 'node-forge';

export interface P12Container {
  certificate: forge.pki.Certificate;
  privateKey: forge.pki.rsa.PrivateKey;
}

const OID_SHORT_NAMES: Record<string, string> = {
  '2.5.4.3': 'CN',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '1.2.840.113549.1.9.1': 'emailAddress',
  '2.5.4.5': 'serialNumber',
};

export function formatRfc4514(attributes: forge.pki.CertificateField[]): string {
  return [...attributes]
    .reverse()
    .map((attr) => {
      const name = attr.shortName || OID_SHORT_NAMES[attr.type as string] || attr.type;
      return `${name}=${attr.value}`;
    })
    .join(',');
}

// Subject attributes that carry the holder's id: serialNumber, UID and organizationIdentifier
// (`IDCEC-<cédula>`, `VATEC-<RUC>` in ETSI certificates)
const ID_ATTRIBUTES = ['2.5.4.5', '0.9.2342.19200300.100.1.1', '2.5.4.97'];
// Ecuadorian CAs (BCE, Security Data, ANF, Uanataca...) write the cédula and the RUC in extensions
// of their own, under their private enterprise number
const PRIVATE_EXTENSIONS = '1.3.6.1.4.1.';
// UTF8String, PrintableString, T61String, IA5String, VisibleString and BMPString
const TEXT_TYPES = new Set<number>([12, 19, 20, 22, 26, 30]);

/** A valid Ecuadorian cédula: province, a third digit below 6 and the mod 10 check digit */
export function isCedula(value: string): boolean {
  if (!/^\d{10}$/.test(value)) return false;
  const province = Number(value.slice(0, 2));
  if (!((province >= 1 && province <= 24) || province === 30) || Number(value[2]) >= 6) {
    return false;
  }
  const sum = [...value.slice(0, 9)].reduce((total, digit, i) => {
    const product = Number(digit) * (i % 2 === 0 ? 2 : 1);
    return total + (product > 9 ? product - 9 : product);
  }, 0);
  return (10 - (sum % 10)) % 10 === Number(value[9]);
}

function texts(der: string): string[] {
  try {
    return collectTexts(forge.asn1.fromDer(der));
  } catch {
    // Not DER: the raw bytes may still be text
    return [der];
  }
}

function collectTexts(node: forge.asn1.Asn1): string[] {
  if (Array.isArray(node.value)) return node.value.flatMap(collectTexts);
  if (node.tagClass !== forge.asn1.Class.UNIVERSAL) return [node.value];
  // BMPString is UTF-16: without its zero bytes the digits read as ASCII
  if (TEXT_TYPES.has(node.type)) return [node.value.replace(/\0/g, '')];
  // Some CAs wrap the text in an OCTET STRING
  return node.type === forge.asn1.Type.OCTETSTRING ? texts(node.value) : [];
}

/**
 * The RUCs (13 digits ending in 001) and cédulas found in the certificate: in its subject and in
 * the private extensions of the CA. Empty when it names neither.
 */
export function certificateTaxIds(certificate: forge.pki.Certificate): string[] {
  const values = [
    ...certificate.subject.attributes
      .filter((attr) => ID_ATTRIBUTES.includes(attr.type as string))
      .map((attr) => String(attr.value)),
    ...(certificate.extensions as { id: string; value: string }[])
      .filter((extension) => extension.id?.startsWith(PRIVATE_EXTENSIONS))
      .flatMap((extension) => texts(extension.value)),
  ];
  const found = values.flatMap((value) => value.match(/(?<!\d)(\d{13}|\d{10})(?!\d)/g) ?? []);
  return [...new Set(found.filter((id) => (id.length === 13 ? id.endsWith('001') : isCedula(id))))];
}

export function parseP12(buffer: Buffer, password: string): P12Container {
  const p12Der = forge.util.decode64(buffer.toString('base64'));
  const p12Asn1 = forge.asn1.fromDer(p12Der);
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });

  const certs = certBags[forge.pki.oids.certBag]?.filter((b) => b.cert) || [];
  const keys = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.filter((b) => b.key) || [];

  if (certs.length === 0) throw new Error('No certificates found in P12 file');
  if (keys.length === 0) throw new Error('No private keys found in P12 file');

  let signingCert = certs[0].cert!;
  let signingKey = keys[0].key! as forge.pki.rsa.PrivateKey;

  for (const certBag of certs) {
    for (const keyBag of keys) {
      const certLocalKeyId = certBag.attributes?.localKeyId?.[0];
      const keyLocalKeyId = keyBag.attributes?.localKeyId?.[0];
      if (certLocalKeyId && keyLocalKeyId && certLocalKeyId === keyLocalKeyId) {
        signingCert = certBag.cert!;
        signingKey = keyBag.key! as forge.pki.rsa.PrivateKey;
        break;
      }
    }
  }

  return { certificate: signingCert, privateKey: signingKey };
}
