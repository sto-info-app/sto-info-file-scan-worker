import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';

import { WORKER_SETTINGS, WorkerSettings } from '../../config/worker-settings';
import {
  RECOVERY_BATCH,
  ScanVerdictPublisherService,
} from './scan-verdict-publisher.service';

/**
 * The most recovery passes one sweep makes.
 *
 * Each pass resends up to {@link RECOVERY_BATCH}, so one sweep clears up to a
 * thousand verdicts and leaves anything beyond that to the next. The limit
 * only matters if a pass stops making progress, and then it is the
 * difference between a sweep that ends and one that does not.
 */
export const MAX_RECOVERY_PASSES = 10;

/**
 * Resends verdicts lost with Redis, at start and then on a timer (FC-042).
 *
 * `resendStrandedVerdicts()` existed from FC-010 and nothing called it, so a
 * verdict that finished while Redis was away stayed in PostgreSQL and its
 * upload stayed in `SCANNING` for good. This calls it once when the worker
 * starts — after every module is ready, so the verdict queue exists — and
 * then every `STRANDED_VERDICT_RESEND_INTERVAL_MS`.
 *
 * **Resending is safe to repeat.** The verdict job's identifier is the
 * attempt's, so BullMQ collapses a resend of a verdict still on the queue,
 * a verdict the backend failed is retried rather than ignored, and the
 * backend refuses a verdict for an asset that is no longer waiting
 * for one. A sweep that races the pipeline's own publish, or another
 * worker's sweep, sends a duplicate that changes nothing.
 *
 * **A failed sweep never stops the worker.** It is logged and the next one
 * tries again.
 */
@Injectable()
export class StrandedVerdictSweepService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly _logger = new Logger(StrandedVerdictSweepService.name);

  private _timer: NodeJS.Timeout | null = null;

  private _inFlight: Promise<number> | null = null;

  /**
   * Creates an instance of StrandedVerdictSweepService.
   *
   * @param _publisher - The verdict queue.
   * @param _settings - The worker's settings.
   */
  constructor(
    private readonly _publisher: ScanVerdictPublisherService,
    @Inject(WORKER_SETTINGS) private readonly _settings: WorkerSettings,
  ) {}

  /**
   * Sweeps once, then keeps sweeping.
   *
   * The first sweep is not awaited. A Redis that is not there yet would
   * otherwise hold up the whole application's start for a job that can
   * perfectly well finish later.
   */
  onApplicationBootstrap(): void {
    void this.sweep();

    this._timer = setInterval(() => {
      void this.sweep();
    }, this._settings.strandedVerdictResendIntervalMs);

    this._timer.unref?.();
  }

  /** Stops sweeping. */
  onModuleDestroy(): void {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Resends every stranded verdict now.
   *
   * Overlapping calls share one sweep, since two would find the same rows.
   *
   * @returns How many verdicts were resent, counting any sent before a
   *   failure.
   */
  sweep(): Promise<number> {
    this._inFlight ??= this.resendAll().finally(() => {
      this._inFlight = null;
    });

    return this._inFlight;
  }

  /**
   * Runs recovery passes until one comes back short.
   *
   * A full pass means there may be more, which after a long Redis outage
   * there will be; a short one means there are not.
   *
   * @returns How many verdicts were resent.
   */
  private async resendAll(): Promise<number> {
    let total = 0;

    try {
      for (let pass = 0; pass < MAX_RECOVERY_PASSES; pass += 1) {
        const resent = await this._publisher.resendStrandedVerdicts();

        total += resent;

        if (resent < RECOVERY_BATCH) {
          break;
        }
      }
    } catch (error) {
      this._logger.error(
        `[resendAll] Stranded verdicts not resent - Resent: ${total}, ` +
          `Reason: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }

    return total;
  }
}
