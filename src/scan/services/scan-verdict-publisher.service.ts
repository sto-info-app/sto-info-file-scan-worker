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
export const RECOVERY_BATCH = 100;

/**
 * The verdict job's identifier: the attempt, and when it answered.
 *
 * The attempt alone used to be enough, when an attempt answered once. An
 * attempt that failed is now reopened by a new request (FC-042), so it can
 * answer `RETRY` and then `CLEAN`, and under one identifier the second would
 * collapse into the first while it waited, or revive the first's `RETRY` if
 * the backend had failed it. Each answer has its own `scannedAt`, so each
 * gets its own job, and the same answer offered twice still collapses. An
 * underscore, because BullMQ refuses a custom identifier with a colon.
 *
 * @param verdict - The verdict.
 * @returns The job identifier.
 */
export function verdictJobId(verdict: ScanVerdictMessage): string {
  return `${verdict.attemptId}_${Date.parse(verdict.scannedAt)}`;
}

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
 *
 * **A verdict the backend failed is sent round again, not dropped** (FC-042).
 * The job identifier is the attempt's and failed jobs are kept, and BullMQ
 * ignores an `add` whose identifier is already in the queue in any state. So
 * a verdict the backend failed would otherwise swallow every later send of
 * the same answer — a retried request, a stranded-verdict sweep — silently,
 * and the upload would wait in `SCANNING` until somebody retried the job by
 * hand.
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
   * The job identifier names the attempt and the answer
   * ({@link verdictJobId}), so BullMQ itself collapses a verdict offered
   * twice. That is a convenience rather than the guarantee: the guarantee is
   * the backend refusing a transition it has already made.
   *
   * When a job under that identifier is sitting in the failed set, it is
   * retried with its attempts restored instead, since an `add` would do
   * nothing. It carries the same answer, built from the same row.
   *
   * @param verdict - What the attempt concluded.
   */
  async publish(verdict: ScanVerdictMessage): Promise<void> {
    const jobId = verdictJobId(verdict);

    if (await this.reviveFailedVerdict(jobId)) {
      this._logger.warn(
        `[publish] Failed verdict sent round again - AttemptId: ` +
          `${verdict.attemptId}`,
      );
    } else {
      await this._queue.add(FILE_SCAN_VERDICT_JOB, verdict, {
        jobId,
        removeOnComplete: true,
        removeOnFail: false,
      });
    }

    await this._attempts.markVerdictPublished(
      verdict.attemptId,
      verdict.scannedAt,
    );

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
   * Counts only what was actually sent, a failed job sent round again
   * included, and never a row it found and skipped: the sweep reads a full
   * batch as a sign there are more to fetch.
   *
   * @returns How many verdicts were resent.
   */
  async resendStrandedVerdicts(): Promise<number> {
    const stranded =
      await this._attempts.findUnpublishedVerdicts(RECOVERY_BATCH);
    let resent = 0;

    for (const attempt of stranded) {
      const verdict = buildVerdictMessage(attempt);

      if (verdict !== null) {
        await this.publish(verdict);
        resent += 1;
      }
    }

    if (resent > 0) {
      this._logger.warn(
        `[resendStrandedVerdicts] Resent ${resent} stranded verdicts`,
      );
    }

    return resent;
  }

  /**
   * Retries a verdict job, if it is in the failed set.
   *
   * A copy of the backend's `reviveFailedJob`, because neither repository can
   * import from the other.
   *
   * @param jobId - The verdict job's identifier.
   * @returns True when a failed job was sent round again; false when there
   *   is no job under that identifier, or it has not failed.
   */
  private async reviveFailedVerdict(jobId: string): Promise<boolean> {
    const job = await this._queue.getJob(jobId);

    if (job === undefined || !(await job.isFailed())) {
      return false;
    }

    await job.retry('failed', {
      resetAttemptsMade: true,
      resetAttemptsStarted: true,
    });

    return true;
  }
}
