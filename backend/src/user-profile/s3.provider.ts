/**
 * AWS S3-compatible StorageProvider implementation.
 *
 * Uses the AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
 * which is already available as a transitive dependency through NestJS packages.
 *
 * Configured entirely from env vars: S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID,
 * S3_SECRET_ACCESS_KEY, and optionally S3_ENDPOINT (for MinIO / Cloudflare R2)
 * and S3_PUBLIC_URL_BASE (for CDN-fronted buckets).
 */
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { StorageProvider, UploadResult } from './s3-storage.service';

export interface S3ProviderConfig {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Custom endpoint for S3-compatible services (MinIO, R2, etc.) */
  endpoint?: string;
  /** CDN base URL. When set, public-facing URLs use this prefix. */
  publicUrlBase?: string;
}

export class S3Provider implements StorageProvider {
  private readonly client: S3Client;

  constructor(private readonly cfg: S3ProviderConfig) {
    this.client = new S3Client({
      region: cfg.region,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
      ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
    });
  }

  async upload(key: string, body: Buffer, contentType: string): Promise<UploadResult> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );

    const url = this.cfg.publicUrlBase
      ? `${this.cfg.publicUrlBase.replace(/\/$/, '')}/${key}`
      : await this.getSignedUrl(key);

    return { url, key };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
    );
  }

  async getSignedUrl(key: string, expiresIn = 3600): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
      { expiresIn },
    );
  }
}
