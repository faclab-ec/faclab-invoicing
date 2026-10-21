import { Certificate } from '../domain/certificate';
import { SecretCipherPort } from '../domain/ports';

export interface SigningKey {
  p12: Buffer;
  password: string;
}

/** Gets the .p12 file and its password, ready to open */
export class CertificateKeyLoader {
  constructor(private readonly cipher: SecretCipherPort) {}

  async load(certificate: Certificate): Promise<SigningKey> {
    if (!certificate.passwordCiphertext) {
      throw new Error('The certificate password was not stored: upload the certificate again');
    }
    const password = this.cipher.decrypt(certificate.passwordCiphertext);
    const p12 = this.cipher.decryptBytes(certificate.p12Ciphertext);
    return { p12, password };
  }
}
