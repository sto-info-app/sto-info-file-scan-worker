import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { DelayedError, Job } from 'bullmq';

import { WORKER_SETTINGS, WorkerSettings } from '../../config/worker-settings';
import {
  FILE_SCAN_REQUEST_QUEUE,
  FileScanContractError,
  parseScanRequestMessage,
} from '../../contract/file-scan-contract';
import {
  EngineHealth,
  EngineHealthService,
  EngineUnfitError,
} from '../../scanning/engine-health.service';
import { FileScanService } from '../services/file-scan.service';
import { ScanVerdictPublisherService } from '../services/scan-verdict-publisher.service';

/**
 * Takes scan requests off the queue.
 *
 * Thin on purpose. It parses the message, hands it to the service and sends
 * whatever comes back; everything that could be called a decision happens
 * somewhere that can be tested without a queue.
 *
 * Two behaviours are the processor's own, and both concern what happens when
 * a job cannot be completed.
 *
 * **A message that violates the contract is discarded, not retried.** It will
 * violate it identically on every attempt, and retrying it three times only
 * delays the moment somebody reads the log. The asset stays where the backend
 * left it, which is not serveable.
 *
 * **Anything else is rethrown**, so BullMQ retries with backoff and, having
 * run out of attempts, keeps the job in its failed set. A job in the failed
 * set is visible; a job swallowed by a catch is not.
 *
 * **A scanner that is not fit to judge files stops the queue instead.** The
 * health service says when that changes and this pauses and resumes the
 * BullMQ worker accordingly, so during a `freshclam` outage jobs simply wait
 * where they are. A job already in hand when the answer changed is moved to
 * delayed rather than failed, because failing it five times is how a queue
 * empties itself into a failed set during an outage that ends on its own —
 * ADR-0020.
 */
// Concurrency is read straight from the environment because a decorator is
// evaluated when the class is defined, long before anything is injected. The
// same variable is validated properly in the settings, and the two are kept
// honest by a test.
@Processor(FILE_SCAN_REQUEST_QUEUE, {
  concurrency: Number(process.env.SCAN_CONCURRENCY ?? 1),
})
export class FileScanProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly _logger = new Logger(FileScanProcessor.name);

  /**
   * Creates an instance of FileScanProcessor.
   *
   * @param _fileScan - The scan pipeline.
   * @param _publisher - The verdict queue.
   * @param _health - What the scanner last said about itself.
   * @param _settings - The worker's settings.
   */
  constructor(
    private readonly _fileScan: FileScanService,
    private readonly _publisher: ScanVerdictPublisherService,
    private readonly _health: EngineHealthService,
    @Inject(WORKER_SETTINGS) private readonly _settings: WorkerSettings,
  ) {
    super();
  }

  /**
   * Matches the queue to the scanner, now and whenever that changes.
   *
   * At bootstrap rather than at module init, because the BullMQ worker this
   * pauses is created by `@nestjs/bullmq` and is not there any earlier. A
   * worker whose scanner is still loading its signatures therefore starts
   * paused, which is the correct way round: it consumes nothing until it can
   * answer for what it consumes.
   */
  onApplicationBootstrap(): void {
    this._health.onChange(health => {
      this.tryToMatchQueueTo(health);
    });

    this.tryToMatchQueueTo(this._health.current());
  }

  /**
   * Handles one job.
   *
   * @param job - The job.
   * @param token - The lock this worker holds the job by.
   */
  async process(job: Job<unknown>, token?: string): Promise<void> {
    let request;

    try {
      request = parseScanRequestMessage(job.data);
    } catch (error) {
      if (error instanceof FileScanContractError) {
        this._logger.error(
          `[process] Message rejected - JobId: ${job.id}, ` +
            `Field: ${error.field}`,
        );

        return;
      }

      throw error;
    }

    if (request.schemaVersion !== this._settings.schemaVersion) {
      this._logger.error(
        `[process] Contract version refused - JobId: ${job.id}, ` +
          `Version: ${request.schemaVersion}`,
      );

      return;
    }

    let verdict;

    try {
      verdict = await this._fileScan.scan(request);
    } catch (error) {
      if (error instanceof EngineUnfitError) {
        throw await this.deferUntilTheScannerIsFit(job, token, error.message);
      }

      throw error;
    }

    if (verdict !== null) {
      await this._publisher.publish(verdict);
    }
  }

  /**
   * Puts a job back to be tried later, unharmed.
   *
   * BullMQ requires both halves of this: the job is moved to the delayed set
   * and then a `DelayedError` is thrown, which is how a processor says "I am
   * not finishing this one" without the job counting as failed. The error is
   * returned rather than thrown here so that the throw is visible at the
   * call site, where the reason for it is.
   *
   * @param job - The job.
   * @param token - The lock this worker holds it by.
   * @param reason - What is wrong with the scanner.
   * @returns The error the caller must throw.
   */
  private async deferUntilTheScannerIsFit(
    job: Job<unknown>,
    token: string | undefined,
    reason: string,
  ): Promise<DelayedError> {
    this._logger.warn(
      `[deferUntilTheScannerIsFit] Job deferred - JobId: ${job.id}, ` +
        `Reason: ${reason}`,
    );

    await job.moveToDelayed(
      Date.now() + this._settings.unhealthyRetryMs,
      token,
    );

    return new DelayedError();
  }

  /**
   * Matches the queue to the scanner without letting a failure escape.
   *
   * Pausing and resuming both talk to Redis, so both can be rejected, and
   * these are called from a health-poll listener with nobody waiting on the
   * promise. An unhandled rejection ends the process under Node's default,
   * which would turn a momentary Redis hiccup into a restart — and a worker
   * that is running is worth more than one that is exactly in step.
   *
   * @param health - What the scanner last said about itself.
   */
  private tryToMatchQueueTo(health: EngineHealth): void {
    void this.matchQueueTo(health).catch((error: unknown) => {
      this._logger.error(
        `[tryToMatchQueueTo] Could not match the queue to the scanner - ` +
          `Reason: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    });
  }

  /**
   * Pauses or resumes consumption to match the scanner.
   *
   * Pausing stops this worker taking new jobs; anything already in hand runs
   * to its own end, which is right, since those files have a scanner that
   * was fit when they started.
   *
   * @param health - What the scanner last said about itself.
   */
  private async matchQueueTo(health: EngineHealth): Promise<void> {
    if (health.healthy === !this.worker.isPaused()) {
      return;
    }

    if (health.healthy) {
      await this.worker.resume();
      this._logger.log('[matchQueueTo] Consuming scan requests again');

      return;
    }

    await this.worker.pause();
    this._logger.warn(
      `[matchQueueTo] Consumption paused - Reason: ${health.reason}`,
    );
  }
}
