import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';

import { Queue } from 'bullmq';

import {
  FILE_SCAN_VERDICT_JOB,
  FILE_SCAN_VERDICT_QUEUE,
  ScanVerdictMessage,
} from '../../contract/file-scan-contract';
import { buildVerdictMessage } from '../verdict-from-attempt';
import { FileScanAttemptService } from './file-scan-attempt.service';

/** How many stranded verdicts one recovery pass will resend. */
const RECOVERY_BATCH = 100;

/**
 * Hands finished verdicts back to the backend.
 *
 * The return half of the contract. The worker cannot write `file_asset` and
 * has no credentials that would let it, so this queue is the only way an
 * answer reaches the thing that decides publication — which is the authority
 * boundary ADR-0015 drew, kept in place by there being no second route.
 *
 * The order of the two writes matters and is the wrong way round on purpose.
 * The verdict goes on the queue first and the attempt is marked published
 * afterwards, so a crash between them leaves a verdict that may be delivered
 * twice. Duplicate delivery is handled — the backend's state machine refuses
 * the second one — whereas the other order would lose verdicts outright, and
 * a lost verdict is an upload that never finishes for anybody.
 */
@Injectable()
export class ScanVerdictPublisherService {
  private readonly _logger = new Logger(ScanVerdictPublisherService.name);

  /**
   * Creates an instance of ScanVerdictPublisherService.
   *
   * @param _queue - The verdict queue.
   * @param _attempts - The attempt record.
   */
  constructor(
    @InjectQueue(FILE_SCAN_VERDICT_QUEUE) private readonly _queue: Queue,
    private readonly _attempts: FileScanAttemptService,
  ) {}

  /**
   * Sends one verdict.
   *
   * The job identifier is the attempt's, so BullMQ itself collapses a verdict
   * offered twice. That is a convenience rather than the guarantee: the
   * guarantee is the backend refusing a transition it has already made.
   *
   * @param verdict - What the attempt concluded.
   */
  async publish(verdict: ScanVerdictMessage): Promise<void> {
    await this._queue.add(FILE_SCAN_VERDICT_JOB, verdict, {
      jobId: verdict.attemptId,
      removeOnComplete: true,
      removeOnFail: false,
    });

    await this._attempts.markVerdictPublished(verdict.attemptId);

    this._logger.log(
      `[publish] Verdict sent - AssetId: ${verdict.assetId}, ` +
        `Outcome: ${verdict.outcome}`,
    );
  }

  /**
   * Resends verdicts that finished but never reached the queue.
   *
   * ADR-0006 accepted Redis becoming load-bearing for file safety and named
   * the recovery this performs as the main new risk: "a Redis loss must be
   * recoverable by re-enqueuing from that table". This is that path, and it
   * reads from PostgreSQL, which is where the authoritative answer is.
   *
   * @returns How many verdicts were resent.
   */
  async resendStrandedVerdicts(): Promise<number> {
    const stranded =
      await this._attempts.findUnpublishedVerdicts(RECOVERY_BATCH);

    for (const attempt of stranded) {
      const verdict = buildVerdictMessage(attempt);

      if (verdict !== null) {
        await this.publish(verdict);
      }
    }

    if (stranded.length > 0) {
      this._logger.warn(
        `[resendStrandedVerdicts] Resent ${stranded.length} stranded verdicts`,
      );
    }

    return stranded.length;
  }
}
