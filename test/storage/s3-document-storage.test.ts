import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';

import { InvoiceIssueError } from '#/modules/invoice/domain/issue';
import { S3DocumentStorage } from '#/modules/invoice/infra/adapters/s3-document-storage.adapter';

// faclab-infra's object-storage (Garage), e.g. TEST_OBJECT_STORAGE_ENDPOINT=http://localhost:3900;
// the other values default to its development key and bucket
const ENDPOINT = process.env.TEST_OBJECT_STORAGE_ENDPOINT;

const config = {
  endpoint: ENDPOINT ?? null,
  region: process.env.TEST_OBJECT_STORAGE_REGION ?? 'garage',
  bucket: process.env.TEST_OBJECT_STORAGE_BUCKET ?? 'faclab-invoicing',
  accessKeyId:
    process.env.TEST_OBJECT_STORAGE_ACCESS_KEY_ID ?? 'GKfac00000000000000000000000000000',
  secretAccessKey:
    process.env.TEST_OBJECT_STORAGE_SECRET_ACCESS_KEY ??
    'facfacfacfacfacfacfacfacfacfacfacfacfacfacfacfacfacfacfacfacfac0',
  forcePathStyle: true,
};

describe.skipIf(!ENDPOINT)('S3DocumentStorage against an S3-compatible service', () => {
  it('keeps a document and reads it back, overwriting the same key', async () => {
    const storage = new S3DocumentStorage(config);
    const key = `tests/${randomUUID()}/invoice.xml`;

    await storage.put(key, '<autorizacion>1</autorizacion>', 'application/xml');
    await storage.put(key, '<autorizacion>Ñandú</autorizacion>', 'application/xml');

    expect(await storage.get(key)).toBe('<autorizacion>Ñandú</autorizacion>');
    storage.destroy();
  });

  it('keeps a binary document byte for byte and deletes it', async () => {
    const storage = new S3DocumentStorage(config);
    const key = `tests/${randomUUID()}/ride.pdf`;
    const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x80, 0x0a]);

    await storage.put(key, pdf, 'application/pdf');
    expect(await storage.getBytes(key)).toEqual(pdf);

    await storage.delete(key);
    expect(await storage.getBytes(key)).toBeNull();
    // Deleting what isn't there is not an error
    await storage.delete(key);
    storage.destroy();
  });

  it('answers null for a key without a document', async () => {
    const storage = new S3DocumentStorage(config);

    expect(await storage.get(`tests/${randomUUID()}/missing.xml`)).toBeNull();
    storage.destroy();
  });

  it('turns a failed upload into a transient issue', async () => {
    const storage = new S3DocumentStorage({ ...config, bucket: `missing-${randomUUID()}` });

    await expect(storage.put('x.xml', '<x/>', 'application/xml')).rejects.toBeInstanceOf(
      InvoiceIssueError,
    );
    storage.destroy();
  });
});
