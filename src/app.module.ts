import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { getTypeOrmConfig } from 'config/typeorm.config';

import { ConfigCheckService } from './config-check/config-check.service';
import { WorkerConfigModule } from './config/worker-config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { QuarantineModule } from './quarantine/quarantine.module';
import { ScanModule } from './scan/scan.module';
import { ScanningModule } from './scanning/scanning.module';
import { SharedModule } from './shared/shared.module';

/**
 * The worker.
 *
 * Five modules that matter, in one direction. Settings are global and
 * depend on nothing; the scanner depends on settings; quarantine depends on
 * settings and secrets; the scan pipeline depends on all three and on the
 * queues; and health depends on the scanner, because that is the question it
 * answers.
 *
 * `ClsModule` has gone with the request-scoped context it was mounting, which
 * nothing read: this process handles queue jobs, not requests, and a
 * correlation identifier travels in the message as `traceId` instead.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: `config/environments/${process.env.NODE_ENV || ''}.env`,
    }),

    WorkerConfigModule,

    TypeOrmModule.forRootAsync({
      imports: [ConfigModule, SharedModule],
      useFactory: async () => getTypeOrmConfig(),
      inject: [ConfigService],
    }),

    BullModule.forRoot({
      connection: { url: process.env.REDIS_URL },
      prefix: process.env.QUEUE_PREFIX || 'bull:sto-info:',
    }),

    SharedModule,
    DatabaseModule,
    QuarantineModule,
    ScanningModule,
    ScanModule,
    HealthModule,
  ],
  providers: [ConfigCheckService],
})
export class AppModule {}
