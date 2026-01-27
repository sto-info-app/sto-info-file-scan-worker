import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UploadFileEntity } from '../db/entities/upload-file.entity';
import { R2Module } from '../r2/r2.module';
import { FileScanProcessor } from './processors/file-scan.processor';
import { FileScanService } from './services/file-scan.service';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: process.env.FILE_SCAN_QUEUE || 'file-scan' },
      { name: process.env.FLEET_IMPORT_QUEUE || 'fleet-import' },
    ),
    TypeOrmModule.forFeature([UploadFileEntity]),
    R2Module,
  ],
  providers: [FileScanProcessor, FileScanService],
})
export class QueueModule {}
