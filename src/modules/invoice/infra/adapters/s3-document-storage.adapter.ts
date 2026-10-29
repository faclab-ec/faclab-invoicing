import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { InvoiceIssueError } from '../../domain/issue';
import { DocumentStorage } from '../../domain/ports';

export interface ObjectStorageConfig {
  // Empty for AWS itself; the URL of any other S3-compatible service (the VPS's, faclab-infra's)
  endpoint: string | null;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  // Most self-hosted services only take bucket/key paths, not bucket subdomains
  forcePathStyle: boolean;
}

/** Documents in a bucket of any S3-compatible object storage (D-2) */
export class S3DocumentStorage implements DocumentStorage {
  private readonly client: S3Client;

  constructor(private readonly config: ObjectStorageConfig) {
    this.client = new S3Client({
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      // Checksums only where S3 requires them: not every compatible service supports the new ones
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async put(key: string, body: string, contentType: string): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new InvoiceIssueError('STORAGE_UNAVAILABLE', `Object storage failed: ${reason}`);
    }
  }

  async get(key: string): Promise<string | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return (await result.Body?.transformToString('utf-8')) ?? null;
    } catch (error) {
      if (error instanceof NoSuchKey) return null;
      throw error;
    }
  }

  destroy(): void {
    this.client.destroy();
  }
}
