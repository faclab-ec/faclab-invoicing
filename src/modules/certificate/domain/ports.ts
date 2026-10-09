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

export interface FileStoragePort {
  upload(key: string, content: Buffer, contentType: string): Promise<string>;
  download(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** Symmetric encryption for secrets kept at rest (certificate passwords) */
export interface SecretCipherPort {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}
