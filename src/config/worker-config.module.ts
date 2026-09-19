import { Global, Module } from '@nestjs/common';

import { readWorkerSettings, WORKER_SETTINGS } from './worker-settings';

/**
 * The worker's settings, read once.
 *
 * Global, because almost everything needs some of it and threading a
 * settings import through every module would be noise. Read at construction
 * rather than lazily, so a configuration mistake stops the process from
 * starting instead of surfacing while it is holding somebody's file.
 */
@Global()
@Module({
  providers: [
    {
      provide: WORKER_SETTINGS,
      useFactory: () => readWorkerSettings(process.env),
    },
  ],
  exports: [WORKER_SETTINGS],
})
export class WorkerConfigModule {}
