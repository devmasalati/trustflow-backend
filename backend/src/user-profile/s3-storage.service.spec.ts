import { ServiceUnavailableException } from '@nestjs/common';
import { S3StorageService, StorageProvider, UploadResult } from './s3-storage.service';
import { setTestEnv, resetEnvConfig } from '../config/env.config';

function makeProvider(): jest.Mocked<StorageProvider> {
  return {
    upload: jest.fn(),
    delete: jest.fn(),
    getSignedUrl: jest.fn(),
  };
}

describe('S3StorageService', () => {
  afterEach(() => {
    resetEnvConfig();
  });

  describe('onModuleInit (production guard)', () => {
    it('throws if NODE_ENV is production and no provider has been registered', () => {
      setTestEnv({ NODE_ENV: 'production' });
      const service = new S3StorageService();

      expect(() => service.onModuleInit()).toThrow(
        /no storage provider has been registered/,
      );
    });

    it('does not throw in production when a provider has been registered', () => {
      setTestEnv({ NODE_ENV: 'production' });
      const service = new S3StorageService();
      service.registerProvider(makeProvider());

      expect(() => service.onModuleInit()).not.toThrow();
    });

    it('does not throw in development without a provider', () => {
      setTestEnv({ NODE_ENV: 'development' });
      const service = new S3StorageService();

      expect(() => service.onModuleInit()).not.toThrow();
    });

    it('does not throw in test without a provider', () => {
      setTestEnv({ NODE_ENV: 'test' });
      const service = new S3StorageService();

      expect(() => service.onModuleInit()).not.toThrow();
    });
  });

  describe('uploadAvatar — no provider (non-production)', () => {
    beforeEach(() => setTestEnv({ NODE_ENV: 'development' }));

    it('returns a placeholder URL with simulated: true', async () => {
      const service = new S3StorageService();
      const result = await service.uploadAvatar(
        Buffer.from('img'),
        'photo.jpg',
        'image/jpeg',
      );

      expect(result.url).toMatch(/^https:\/\/placeholder\.trustflow\.xyz\/avatars\//);
      expect(result.simulated).toBe(true);
    });

    it('includes the generated key in the placeholder result', async () => {
      const service = new S3StorageService();
      const result = await service.uploadAvatar(
        Buffer.from('img'),
        'avatar.png',
        'image/png',
      );

      expect(result.key).toMatch(/^avatars\//);
      expect(result.url).toContain(result.key);
    });
  });

  describe('uploadAvatar — with a registered provider', () => {
    beforeEach(() => setTestEnv({ NODE_ENV: 'development' }));

    it('delegates to the provider and returns its result without simulated flag', async () => {
      const provider = makeProvider();
      provider.upload.mockResolvedValue({
        url: 'https://cdn.example.com/avatars/real.jpg',
        key: 'avatars/real.jpg',
      });

      const service = new S3StorageService();
      service.registerProvider(provider);

      const result = await service.uploadAvatar(
        Buffer.from('img'),
        'photo.jpg',
        'image/jpeg',
      );

      expect(provider.upload).toHaveBeenCalledWith(
        expect.stringMatching(/^avatars\//),
        expect.any(Buffer),
        'image/jpeg',
      );
      expect(result.url).toBe('https://cdn.example.com/avatars/real.jpg');
      expect(result.simulated).toBeUndefined();
    });
  });

  describe('deleteAvatar', () => {
    beforeEach(() => setTestEnv({ NODE_ENV: 'development' }));

    it('no-ops without a provider', async () => {
      const service = new S3StorageService();
      await expect(service.deleteAvatar('avatars/foo.jpg')).resolves.toBeUndefined();
    });

    it('delegates to provider when configured', async () => {
      const provider = makeProvider();
      provider.delete.mockResolvedValue(undefined);

      const service = new S3StorageService();
      service.registerProvider(provider);
      await service.deleteAvatar('avatars/foo.jpg');

      expect(provider.delete).toHaveBeenCalledWith('avatars/foo.jpg');
    });
  });

  describe('getAvatarUrl', () => {
    beforeEach(() => setTestEnv({ NODE_ENV: 'development' }));

    it('returns a placeholder URL without a provider', async () => {
      const service = new S3StorageService();
      const url = await service.getAvatarUrl('avatars/foo.jpg');
      expect(url).toBe('https://placeholder.trustflow.xyz/avatars/avatars/foo.jpg');
    });

    it('delegates to provider when configured', async () => {
      const provider = makeProvider();
      provider.getSignedUrl.mockResolvedValue('https://s3.example.com/signed');

      const service = new S3StorageService();
      service.registerProvider(provider);
      const url = await service.getAvatarUrl('avatars/foo.jpg', 300);

      expect(provider.getSignedUrl).toHaveBeenCalledWith('avatars/foo.jpg', 300);
      expect(url).toBe('https://s3.example.com/signed');
    });
  });
});
