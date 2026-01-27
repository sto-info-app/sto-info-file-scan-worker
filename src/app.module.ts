import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';

import { UploadFileEntity } from './db/entities/upload-file.entity';
import { R2Module } from './r2/r2.module';
import { QueueModule } from './queue/queue.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    TypeOrmModule.forRootAsync({
      useFactory: () => ({
        type: 'postgres',
        url: process.env.DATABASE_URL,
        entities: [UploadFileEntity],
        synchronize: false,
        ssl:
          process.env.NODE_ENV === 'production'
            ? { rejectUnauthorized: false }
            : undefined,
      }),
    }),
    TypeOrmModule.forFeature([UploadFileEntity]),

    BullModule.forRoot({
      connection: { url: process.env.REDIS_URL },
      prefix: process.env.QUEUE_PREFIX || 'bull:sto-info:',
    }),

    R2Module,
    QueueModule,
    HealthModule,
  ],
})
export class AppModule {}
