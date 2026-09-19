import { Module } from '@nestjs/common';

import { ClamdScanEngineService } from './clamd-scan-engine.service';
import { CLAMD_SOCKET_FACTORY, createClamdSocket } from './clamd-socket';
import { SCAN_ENGINE } from './scan-engine.interface';

/**
 * The scanner, behind the interface ADR-0005 requires.
 *
 * One implementation today. The module exists so that there is exactly one
 * place to change when there are two: the natural escalation that record
 * names — moving `clamd` out into its own Render private service — changes
 * the socket factory and nothing else, and swapping the engine outright
 * changes the `SCAN_ENGINE` provider and nothing else.
 */
@Module({
  providers: [
    { provide: CLAMD_SOCKET_FACTORY, useValue: createClamdSocket },
    { provide: SCAN_ENGINE, useClass: ClamdScanEngineService },
  ],
  exports: [SCAN_ENGINE],
})
export class ScanningModule {}
