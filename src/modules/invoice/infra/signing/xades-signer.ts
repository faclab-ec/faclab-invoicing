/* global Document, Element, Node */
import { DOMImplementation, DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { createHash, createPrivateKey, createSign, randomInt } from 'crypto';
import { DateTime } from 'luxon';
import { C14nCanonicalization } from 'xml-crypto';

import { SigningCredentials } from './p12-reader';

const NS = {
  ds: 'http://www.w3.org/2000/09/xmldsig#',
  etsi: 'http://uri.etsi.org/01903/v1.3.2#',
} as const;

const ALGORITHMS = {
  digest: 'http://www.w3.org/2000/09/xmldsig#sha1',
  signature: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
  canonicalization: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
  envelopedSignature: 'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
} as const;

const ANCESTOR_NAMESPACES = [
  { prefix: 'ds', namespaceURI: NS.ds },
  { prefix: 'etsi', namespaceURI: NS.etsi },
];

interface SignatureIds {
  certificateId: string;
  signatureId: string;
  signedPropertiesId: string;
  objectId: string;
  signedInfoId: string;
  signedPropertiesIDId: string;
  referenceIDId: string;
  signatureValueId: string;
}

function generateToken(): number {
  return randomInt(1, 100001);
}

function buildIdentifiers(): SignatureIds {
  return {
    certificateId: `Certificate${generateToken()}`,
    signatureId: `Signature${generateToken()}`,
    signedPropertiesId: `SignedProperties${generateToken()}`,
    objectId: `Object${generateToken()}`,
    signedInfoId: `Signature-SignedInfo${generateToken()}`,
    signedPropertiesIDId: `SignedPropertiesID${generateToken()}`,
    referenceIDId: `Reference-ID-${generateToken()}`,
    signatureValueId: `SignatureValue${generateToken()}`,
  };
}

function sha1Base64(data: string | Buffer): string {
  return createHash('sha1').update(data).digest('base64');
}

function wrapBase64(b64: string, lineLength = 76): string {
  return b64.match(new RegExp(`.{1,${lineLength}}`, 'g'))?.join('\n') ?? b64;
}

function canonicalize(node: Node, includeSignatureNs = false): string {
  const c14n = new C14nCanonicalization();
  const options = includeSignatureNs ? { ancestorNamespaces: ANCESTOR_NAMESPACES } : {};
  return c14n.process(node, options);
}

function rsaSha1Sign(data: string, keyDer: Buffer): Buffer {
  const privateKey = createPrivateKey({
    key: keyDer,
    format: 'der',
    type: 'pkcs1',
  });
  const signer = createSign('RSA-SHA1');
  signer.update(data);
  return signer.sign(privateKey);
}

export class XadesSigner {
  constructor(private readonly timezone: string) {}

  sign(xml: string, credentials: SigningCredentials): string {
    const ids = buildIdentifiers();
    const doc = new DOMImplementation().createDocument(null, null, null);

    // Parse voucher and compute its canonical digest
    const parser = new DOMParser();
    const voucherDoc = parser.parseFromString(xml, 'text/xml');
    const voucherRoot = voucherDoc.documentElement!;
    const voucherC14n = canonicalize(voucherRoot);
    const voucherB64 = sha1Base64(voucherC14n);

    // Build signature components
    const [objectNode, signedPropsB64] = this.buildObjectNode(doc, ids, credentials);
    const [keyInfoNode, keyInfoB64] = this.buildKeyInfoNode(doc, ids, credentials);
    const signedInfoNode = this.buildSignedInfoNode(
      doc,
      ids,
      signedPropsB64,
      keyInfoB64,
      voucherB64,
    );
    const signatureValueNode = this.buildSignatureValueNode(
      doc,
      ids,
      signedInfoNode,
      credentials.keyDer,
    );

    // Assemble ds:Signature
    const signatureNode = this.assembleSignature(
      doc,
      ids,
      signedInfoNode,
      signatureValueNode,
      keyInfoNode,
      objectNode,
    );

    // Import into voucher document and append
    const imported = voucherDoc.importNode(signatureNode, true);
    voucherRoot.appendChild(imported);

    // Serialize (element only, then prepend XML declaration)
    const serializer = new XMLSerializer();
    const signedXml = serializer.serializeToString(voucherRoot);
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + signedXml;
  }

  /** Create a namespace-prefixed element (mirrors Python _create_node). */
  private el(
    doc: Document,
    ns: string,
    name: string,
    parent?: Element,
    attrs?: Record<string, string>,
    text?: string,
    tail?: string,
  ): Element {
    const prefix = ns === NS.ds ? 'ds' : 'etsi';
    const element = doc.createElementNS(ns, `${prefix}:${name}`);

    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        element.setAttribute(key, value);
      }
    }

    // lxml node.text = text before first child
    if (text !== undefined) {
      element.appendChild(doc.createTextNode(text));
    }

    if (parent) {
      parent.appendChild(element);
      // lxml node.tail = text after closing tag in parent context
      if (tail !== undefined) {
        parent.appendChild(doc.createTextNode(tail));
      }
    }

    return element;
  }

  private buildObjectNode(
    doc: Document,
    ids: SignatureIds,
    credentials: SigningCredentials,
  ): [Element, string] {
    const signedTime = DateTime.now()
      .setZone(this.timezone)
      .startOf('second')
      .toISO({ suppressMilliseconds: true })!;

    const certDigestB64 = sha1Base64(credentials.certDer);

    const objectNode = this.el(doc, NS.ds, 'Object', undefined, {
      Id: `${ids.signatureId}-${ids.objectId}`,
    });

    const qualifyingProps = this.el(doc, NS.etsi, 'QualifyingProperties', objectNode, {
      Target: `#${ids.signatureId}`,
    });

    const signedProperties = this.el(doc, NS.etsi, 'SignedProperties', qualifyingProps, {
      Id: `${ids.signatureId}-${ids.signedPropertiesId}`,
    });

    const signedSigProps = this.el(doc, NS.etsi, 'SignedSignatureProperties', signedProperties);

    this.el(doc, NS.etsi, 'SigningTime', signedSigProps, undefined, signedTime);

    const signingCert = this.el(doc, NS.etsi, 'SigningCertificate', signedSigProps);
    const cert = this.el(doc, NS.etsi, 'Cert', signingCert);
    const certDigest = this.el(doc, NS.etsi, 'CertDigest', cert);
    this.el(doc, NS.ds, 'DigestMethod', certDigest, { Algorithm: ALGORITHMS.digest });
    this.el(doc, NS.ds, 'DigestValue', certDigest, undefined, certDigestB64);

    const issuerSerial = this.el(doc, NS.etsi, 'IssuerSerial', cert);
    this.el(doc, NS.ds, 'X509IssuerName', issuerSerial, undefined, credentials.issuerRfc4514);
    this.el(doc, NS.ds, 'X509SerialNumber', issuerSerial, undefined, credentials.serialNumber);

    const signedDataProps = this.el(doc, NS.etsi, 'SignedDataObjectProperties', signedProperties);
    const dataObjFmt = this.el(doc, NS.etsi, 'DataObjectFormat', signedDataProps, {
      ObjectReference: `#${ids.referenceIDId}`,
    });
    this.el(doc, NS.etsi, 'Description', dataObjFmt, undefined, 'contenido comprobante');
    this.el(doc, NS.etsi, 'MimeType', dataObjFmt, undefined, 'text/xml');

    // Canonicalize SignedProperties and compute digest
    const signedPropsC14n = canonicalize(signedProperties, true);
    const signedPropsB64 = sha1Base64(signedPropsC14n);

    return [objectNode, signedPropsB64];
  }

  private buildKeyInfoNode(
    doc: Document,
    ids: SignatureIds,
    credentials: SigningCredentials,
  ): [Element, string] {
    const certChain = wrapBase64(credentials.certBase64);
    const modulusB64 = wrapBase64(credentials.modulus.toString('base64'));
    const exponentB64 = credentials.exponent.toString('base64');

    const keyInfo = this.el(doc, NS.ds, 'KeyInfo', undefined, { Id: ids.certificateId }, '\n');

    const x509Data = this.el(doc, NS.ds, 'X509Data', keyInfo, undefined, '\n', '\n');
    this.el(doc, NS.ds, 'X509Certificate', x509Data, undefined, `\n${certChain}\n`, '\n');

    const keyValue = this.el(doc, NS.ds, 'KeyValue', keyInfo, undefined, '\n', '\n');
    const rsaKeyValue = this.el(doc, NS.ds, 'RSAKeyValue', keyValue, undefined, '\n', '\n');
    this.el(doc, NS.ds, 'Modulus', rsaKeyValue, undefined, `\n${modulusB64}\n`, '\n');
    this.el(doc, NS.ds, 'Exponent', rsaKeyValue, undefined, exponentB64, '\n');

    // Canonicalize KeyInfo and compute digest
    const keyInfoC14n = canonicalize(keyInfo, true);
    const keyInfoB64 = sha1Base64(keyInfoC14n);

    return [keyInfo, keyInfoB64];
  }

  private buildSignedInfoNode(
    doc: Document,
    ids: SignatureIds,
    signedPropsB64: string,
    keyInfoB64: string,
    voucherB64: string,
  ): Element {
    const signedInfo = this.el(doc, NS.ds, 'SignedInfo', undefined, { Id: ids.signedInfoId }, '\n');

    this.el(
      doc,
      NS.ds,
      'CanonicalizationMethod',
      signedInfo,
      { Algorithm: ALGORITHMS.canonicalization },
      undefined,
      '\n',
    );

    this.el(
      doc,
      NS.ds,
      'SignatureMethod',
      signedInfo,
      { Algorithm: ALGORITHMS.signature },
      undefined,
      '\n',
    );

    // Reference 1: SignedProperties
    const ref1 = this.el(
      doc,
      NS.ds,
      'Reference',
      signedInfo,
      {
        Id: ids.signedPropertiesIDId,
        Type: 'http://uri.etsi.org/01903#SignedProperties',
        URI: `#${ids.signatureId}-${ids.signedPropertiesId}`,
      },
      '\n',
      '\n',
    );
    this.el(doc, NS.ds, 'DigestMethod', ref1, { Algorithm: ALGORITHMS.digest }, undefined, '\n');
    this.el(doc, NS.ds, 'DigestValue', ref1, undefined, signedPropsB64, '\n');

    // Reference 2: KeyInfo
    const ref2 = this.el(
      doc,
      NS.ds,
      'Reference',
      signedInfo,
      { URI: `#${ids.certificateId}` },
      '\n',
      '\n',
    );
    this.el(doc, NS.ds, 'DigestMethod', ref2, { Algorithm: ALGORITHMS.digest }, undefined, '\n');
    this.el(doc, NS.ds, 'DigestValue', ref2, undefined, keyInfoB64, '\n');

    // Reference 3: Document (voucher)
    const ref3 = this.el(
      doc,
      NS.ds,
      'Reference',
      signedInfo,
      { Id: ids.referenceIDId, URI: '#comprobante' },
      '\n',
      '\n',
    );
    const transforms = this.el(doc, NS.ds, 'Transforms', ref3, undefined, '\n', '\n');
    this.el(
      doc,
      NS.ds,
      'Transform',
      transforms,
      { Algorithm: ALGORITHMS.envelopedSignature },
      undefined,
      '\n',
    );
    this.el(doc, NS.ds, 'DigestMethod', ref3, { Algorithm: ALGORITHMS.digest }, undefined, '\n');
    this.el(doc, NS.ds, 'DigestValue', ref3, undefined, voucherB64, '\n');

    return signedInfo;
  }

  private buildSignatureValueNode(
    doc: Document,
    ids: SignatureIds,
    signedInfoNode: Element,
    keyDer: Buffer,
  ): Element {
    const signedInfoC14n = canonicalize(signedInfoNode, true);
    const signature = rsaSha1Sign(signedInfoC14n, keyDer);
    const signatureB64 = wrapBase64(signature.toString('base64'));

    return this.el(
      doc,
      NS.ds,
      'SignatureValue',
      undefined,
      { Id: ids.signatureValueId },
      `\n${signatureB64}\n`,
    );
  }

  private assembleSignature(
    doc: Document,
    ids: SignatureIds,
    signedInfo: Element,
    signatureValue: Element,
    keyInfo: Element,
    objectNode: Element,
  ): Element {
    const signature = doc.createElementNS(NS.ds, 'ds:Signature');
    signature.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:ds', NS.ds);
    signature.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:etsi', NS.etsi);
    signature.setAttribute('Id', ids.signatureId);
    signature.appendChild(doc.createTextNode('\n'));

    signature.appendChild(signedInfo);
    signature.appendChild(doc.createTextNode('\n'));
    signature.appendChild(signatureValue);
    signature.appendChild(doc.createTextNode('\n'));
    signature.appendChild(keyInfo);
    signature.appendChild(doc.createTextNode('\n'));
    signature.appendChild(objectNode);

    return signature;
  }
}
