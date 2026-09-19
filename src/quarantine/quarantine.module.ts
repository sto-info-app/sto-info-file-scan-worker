import { Module } from '@nestjs/common';

import { S3Client } from '@aws-sdk/client-s3';

import { WORKER_SETTINGS, WorkerSettings } from '../config/worker-settings';
import { SecretsService } from '../shared/secrets/secrets.service';
import { SharedModule } from '../shared/shared.module';
import {
  QUARANTINE_S3_CLIENT,
  QuarantineObjectService,
} from './quarantine-object.service';

/**
 * Read-only access to the private quarantine bucket.
 *
 * The credentials come from AWS Secrets Manager, which ADR-0006 decision 5
 * retained as the worker's existing mechanism and required to be
 * least-privilege. Least-privilege here means precisely one thing the worker
 * may do — read an object from the quarantine bucket — and everything else
 * it may not: it cannot write there, cannot delete there, and has no
 * credential at all for the bucket the site delivers from.
 *
 * That is not tidiness. A scanner that can alter what it scans, or publish
 * what it cleared, is a scanner whose verdict proves nothing about the bytes
 * anybody will actually be served.
 */
@Module({
  imports: [SharedModule],
  providers: [
    QuarantineObjectService,
    {
      provide: QUARANTINE_S3_CLIENT,
      useFactory: async (
        settings: WorkerSettings,
        secretsService: SecretsService,
      ) => {
        const secretObject = await secretsService.getSecret(
          settings.awsSecretName,
        );

        return new S3Client({
          region: 'auto',
          endpoint: settings.quarantineEndpoint,
          credentials: {
            accessKeyId: secretObject.cloudflareR2QuarantineReadKey,
            secretAccessKey: secretObject.cloudflareR2QuarantineReadSecret,
          },
        });
      },
      inject: [WORKER_SETTINGS, SecretsService],
    },
  ],
  exports: [QuarantineObjectService],
})
export class QuarantineModule {}
