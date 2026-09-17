import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { ClsModule } from 'nestjs-cls';
import { getTypeOrmConfig } from 'config/typeorm.config';

import { SharedModule } from './shared/shared.module';
import { R2Module } from './r2/r2.module';
import { QueueModule } from './queue/queue.module';
import { HealthModule } from './health/health.module';
import { DatabaseModule } from './database/database.module';
import { ConfigCheckService } from './config-check/config-check.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: `config/environments/${process.env.NODE_ENV || ''}.env`,
    }),

    TypeOrmModule.forRootAsync({
      imports: [ConfigModule, SharedModule],
      useFactory: async () => {
        const typeOrmConfig = await getTypeOrmConfig();
        return typeOrmConfig;
      },
      inject: [ConfigService],
    }),

    BullModule.forRoot({
      connection: { url: process.env.REDIS_URL },
      prefix: process.env.QUEUE_PREFIX || 'bull:sto-info:',
    }),

    ClsModule.forRoot({
      global: true,
      middleware: { mount: true },
    }),

    SharedModule,
    R2Module,
    QueueModule,
    HealthModule,
    DatabaseModule,
  ],
  providers: [ConfigCheckService],
})
export class AppModule {}
