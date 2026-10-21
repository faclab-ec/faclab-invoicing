export interface P12Metadata {
  serialNumber: string;
  subject: string;
  issuer: string;
  validFrom: Date;
  validTo: Date;
}

export interface P12ParserPort {
  parse(buffer: Buffer, password: string): P12Metadata;
}

/** Symmetric encryption for secrets kept at rest (certificate files and passwords) */
export interface SecretCipherPort {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
  encryptBytes(data: Buffer): string;
  decryptBytes(ciphertext: string): Buffer;
}
