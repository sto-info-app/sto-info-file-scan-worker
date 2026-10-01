import { Module } from '@nestjs/common';

import { ScanningModule } from '../scanning/scanning.module';
import { WorkerHeartbeatService } from './worker-heartbeat.service';

/**
 * The row that tells the backend this worker is alive (FC-042).
 *
 * Depends on the scanner because the row says why a worker is paused and
 * which signatures it last saw. Exported to the scan module, whose processor
 * starts it: the processor is what the row reports on.
 */
@Module({
  imports: [ScanningModule],
  providers: [WorkerHeartbeatService],
  exports: [WorkerHeartbeatService],
})
export class HeartbeatModule {}
