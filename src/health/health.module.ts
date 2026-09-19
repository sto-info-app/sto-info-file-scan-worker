import { Module } from '@nestjs/common';

import { ScanningModule } from '../scanning/scanning.module';
import { HealthController } from './health.controller';

/**
 * The probes an orchestrator reads.
 *
 * Depends on the scanner because readiness is a question about the scanner.
 * A probe that only reported whether Nest had started would answer "yes" for
 * an instance that cannot scan anything, and the orchestrator would keep
 * sending it files.
 */
@Module({
  imports: [ScanningModule],
  controllers: [HealthController],
})
export class HealthModule {}
