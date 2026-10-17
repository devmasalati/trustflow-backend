import { Module } from '@nestjs/common';
import { UserProfileController } from './user-profile.controller';
import { UserProfileService } from './user-profile.service';
import { S3StorageService } from './s3-storage.service';
import { S3Provider } from './s3.provider';
import { MonitoringModule } from '../monitoring/monitoring.module';
import { config } from '../config/env.config';

@Module({
  imports: [MonitoringModule],
  controllers: [UserProfileController],
  providers: [
    UserProfileService,
    {
      provide: S3StorageService,
      useFactory: (): S3StorageService => {
        const service = new S3StorageService();

        // Register a real S3 provider when all required credentials are present.
        // In production onModuleInit() will throw if none is registered (startup guard).
        if (
          config.S3_BUCKET &&
          config.S3_REGION &&
          config.S3_ACCESS_KEY_ID &&
          config.S3_SECRET_ACCESS_KEY
        ) {
          service.registerProvider(
            new S3Provider({
              bucket: config.S3_BUCKET,
              region: config.S3_REGION,
              accessKeyId: config.S3_ACCESS_KEY_ID,
              secretAccessKey: config.S3_SECRET_ACCESS_KEY,
              endpoint: config.S3_ENDPOINT,
              publicUrlBase: config.S3_PUBLIC_URL_BASE,
            }),
          );
        }

        return service;
      },
    },
  ],
  exports: [UserProfileService, S3StorageService],
})
export class UserProfileModule {}
