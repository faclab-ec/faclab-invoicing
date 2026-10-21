import { randomBytes } from 'crypto';
import { describe, expect, it } from 'vitest';

import { AesGcmSecretCipher } from '#/shared/infra/secret-cipher';

const key = () => randomBytes(32).toString('base64');

describe('AesGcmSecretCipher', () => {
  it('decrypts what it encrypted, with a new IV each time', () => {
    const cipher = new AesGcmSecretCipher(key());

    const first = cipher.encrypt('clave-del-certificado');
    const second = cipher.encrypt('clave-del-certificado');

    expect(first).not.toBe(second);
    expect(first).not.toContain('clave');
    expect(cipher.decrypt(first)).toBe('clave-del-certificado');
  });

  it('encrypts files: the .p12 bytes come back unchanged', () => {
    const cipher = new AesGcmSecretCipher(key());
    const p12 = randomBytes(2048);

    const ciphertext = cipher.encryptBytes(p12);

    expect(ciphertext.startsWith('v1:')).toBe(true);
    expect(cipher.decryptBytes(ciphertext).equals(p12)).toBe(true);
  });

  it('fails with another key', () => {
    const ciphertext = new AesGcmSecretCipher(key()).encrypt('secret');
    expect(() => new AesGcmSecretCipher(key()).decrypt(ciphertext)).toThrow();
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => new AesGcmSecretCipher(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });
});
