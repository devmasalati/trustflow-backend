import { Injectable, OnModuleInit } from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { config } from '../config/env.config';

export interface UploadResult {
  url: string;
  key: string;
  /** Present and `true` only when the upload was handled by the no-op placeholder
   *  (i.e. no real storage provider is configured). Never set in production. */
  simulated?: true;
}

export interface StorageProvider {
  upload(key: string, body: Buffer, contentType: string): Promise<UploadResult>;
  delete(key: string): Promise<void>;
  getSignedUrl(key: string, expiresIn?: number): Promise<string>;
}

/**
 * S3-compatible storage service for avatar uploads.
 *
 * Uses a pluggable StorageProvider so the actual S3 client can be swapped
 * (AWS S3, MinIO, Cloudflare R2, etc.) without changing the rest of the app.
 * When no provider is configured in non-production, falls back to a no-op that
 * returns a placeholder URL with `simulated: true` — useful for local dev and
 * testing, but never silently in production.
 *
 * Production startup guard: if NODE_ENV === 'production' and no provider has been
 * registered by the time onModuleInit() runs, the application refuses to start
 * (mirroring the pattern used by IpfsPinningService — see #409).
 */
@Injectable()
export class S3StorageService implements OnModuleInit {
  private readonly logger = new SanitizedLogger(S3StorageService.name);
  private provider: StorageProvider | null = null;

  registerProvider(provider: StorageProvider): void {
    this.provider = provider;
  }

  onModuleInit(): void {
    if (!this.provider && config.NODE_ENV === 'production') {
      throw new Error(
        'S3StorageService: no storage provider has been registered. ' +
          'Set S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY ' +
          'before deploying to production — avatar uploads must not silently return ' +
          'placeholder URLs in a live environment.',
      );
    }

    if (!this.provider) {
      this.logger.warn(
        'S3StorageService: no storage provider configured — avatar uploads will return ' +
          'placeholder URLs (simulated: true). Set S3_* env vars to enable real storage.',
      );
    }
  }

  async uploadAvatar(
    fileBuffer: Buffer,
    originalName: string,
    contentType: string,
  ): Promise<UploadResult> {
    const key = this.generateKey(originalName);

    if (!this.provider) {
      this.logger.warn('No storage provider configured — returning placeholder URL');
      return {
        url: `https://placeholder.trustflow.xyz/avatars/${key}`,
        key,
        simulated: true,
      };
    }

    return this.provider.upload(key, fileBuffer, contentType);
  }

  async deleteAvatar(key: string): Promise<void> {
    if (!this.provider) {
      this.logger.warn('No storage provider configured — skipping delete');
      return;
    }
    return this.provider.delete(key);
  }

  async getAvatarUrl(key: string, expiresIn?: number): Promise<string> {
    if (!this.provider) {
      return `https://placeholder.trustflow.xyz/avatars/${key}`;
    }
    return this.provider.getSignedUrl(key, expiresIn);
  }

  private generateKey(originalName: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).slice(2, 10);
    const ext = originalName.split('.').pop() || 'jpg';
    return `avatars/${timestamp}-${random}.${ext}`;
  }
}
