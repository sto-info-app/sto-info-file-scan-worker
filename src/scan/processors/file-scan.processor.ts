import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';

import { Job } from 'bullmq';

import { WORKER_SETTINGS, WorkerSettings } from '../../config/worker-settings';
import {
  FILE_SCAN_REQUEST_QUEUE,
  FileScanContractError,
  parseScanRequestMessage,
} from '../../contract/file-scan-contract';
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
 */
// Concurrency is read straight from the environment because a decorator is
// evaluated when the class is defined, long before anything is injected. The
// same variable is validated properly in the settings, and the two are kept
// honest by a test.
@Processor(FILE_SCAN_REQUEST_QUEUE, {
  concurrency: Number(process.env.SCAN_CONCURRENCY ?? 1),
})
export class FileScanProcessor extends WorkerHost {
  private readonly _logger = new Logger(FileScanProcessor.name);

  /**
   * Creates an instance of FileScanProcessor.
   *
   * @param _fileScan - The scan pipeline.
   * @param _publisher - The verdict queue.
   * @param _settings - The worker's settings.
   */
  constructor(
    private readonly _fileScan: FileScanService,
    private readonly _publisher: ScanVerdictPublisherService,
    @Inject(WORKER_SETTINGS) private readonly _settings: WorkerSettings,
  ) {
    super();
  }

  /**
   * Handles one job.
   *
   * @param job - The job.
   */
  async process(job: Job<unknown>): Promise<void> {
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

    const verdict = await this._fileScan.scan(request);

    if (verdict !== null) {
      await this._publisher.publish(verdict);
    }
  }
}
