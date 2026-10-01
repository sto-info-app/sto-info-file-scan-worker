import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import {
  FILE_SCAN_REQUEST_QUEUE,
  FILE_SCAN_VERDICT_QUEUE,
} from '../contract/file-scan-contract';
import { HeartbeatModule } from '../heartbeat/heartbeat.module';
import { QuarantineModule } from '../quarantine/quarantine.module';
import { ScanningModule } from '../scanning/scanning.module';
import { FileScanAttemptEntity } from './entities/file-scan-attempt.entity';
import { FileScanProcessor } from './processors/file-scan.processor';
import { FileScanAttemptService } from './services/file-scan-attempt.service';
import { FileScanService } from './services/file-scan.service';
import { ScanVerdictPublisherService } from './services/scan-verdict-publisher.service';
import { StrandedVerdictSweepService } from './services/stranded-verdict-sweep.service';

/**
 * The worker's reason for existing: take a request, answer with a verdict.
 *
 * Both queues are registered here, and the asymmetry between them is the
 * point. The request queue has a processor, so this process consumes it. The
 * verdict queue has none, so this process only ever writes to it. There is no
 * code in this repository that reads a verdict, which is the simplest
 * possible expression of ADR-0015's boundary: the side that scans cannot act
 * on what it found.
 */
@Module({
  imports: [
    BullModule.registerQueue(
      { name: FILE_SCAN_REQUEST_QUEUE },
      { name: FILE_SCAN_VERDICT_QUEUE },
    ),
    TypeOrmModule.forFeature([FileScanAttemptEntity]),
    QuarantineModule,
    ScanningModule,
    HeartbeatModule,
  ],
  providers: [
    FileScanAttemptService,
    FileScanService,
    FileScanProcessor,
    ScanVerdictPublisherService,
    StrandedVerdictSweepService,
  ],
  exports: [ScanVerdictPublisherService],
})
export class ScanModule {}
