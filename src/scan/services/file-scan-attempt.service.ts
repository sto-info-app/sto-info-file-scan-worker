import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { IsNull, Repository } from 'typeorm';

import {
  WORKER_DATABASE_SCHEMA,
  WORKER_SETTINGS,
  WorkerSettings,
} from '../../config/worker-settings';
import {
  ScanRejectionCode,
  ScanRequestMessage,
} from '../../contract/file-scan-contract';
import { ScanEngineDescription } from '../../scanning/scan-engine.interface';
import { FileScanAttemptEntity } from '../entities/file-scan-attempt.entity';
import { FileScanAttemptState } from '../enums/file-scan-attempt-state.enum';

/** The fully qualified table this service writes. */
const TABLE = `"${WORKER_DATABASE_SCHEMA}"."file_scan_attempt"`;

/** The states an attempt may still be worked on from. */
const OPEN_STATES = `('CLAIMED', 'SCANNING')`;

/** What a claim found. */
export type ClaimOutcome =
  /** The attempt is this worker's, and the bytes may be read. */
  | { readonly kind: 'CLAIMED'; readonly attempt: FileScanAttemptEntity }
  /**
   * The attempt has already finished.
   *
   * A duplicate delivery. The verdict is re-sent from the existing row rather
   * than recalculated, which is what makes at-least-once delivery safe:
   * a second message produces the same answer as the first because it *is*
   * the first answer.
   */
  | { readonly kind: 'DUPLICATE'; readonly attempt: FileScanAttemptEntity }
  /**
   * Another worker holds a live lease.
   *
   * Nothing is written and nothing is said. The holder will answer, or its
   * lease will lapse and this message will be redelivered.
   */
  | { readonly kind: 'BUSY' }
  /**
   * The attempt has been claimed as often as it is allowed to be.
   *
   * Refused here rather than retried for ever. The row is moved to `REJECTED`
   * so the backend hears a final answer, because an asset that stays
   * `SCANNING` because a worker keeps crashing is an upload nobody is ever
   * told about.
   */
  | { readonly kind: 'EXHAUSTED'; readonly attempt: FileScanAttemptEntity };

/** How an attempt finished. */
export interface AttemptCompletion {
  /** The state it finished in. */
  readonly state: FileScanAttemptState;
  /** The hash of the bytes that were read, when they were read. */
  readonly observedSha256: string | null;
  /** How many bytes were read, when any were. */
  readonly byteSize: number | null;
  /** What the first bytes looked like, when anything recognised them. */
  readonly detectedContentType: string | null;
  /** Why it refused, when it did. */
  readonly rejectionCode: ScanRejectionCode | null;
  /** What went wrong, for an administrator. */
  readonly failureReason: string | null;
  /** The scanner's version, as it reported it. */
  readonly engineVersion: string | null;
  /** The signature database's version, as it reported it. */
  readonly signatureVersion: string | null;
}

/**
 * The worker's record of what it has scanned, and who is scanning what.
 *
 * Every write here is a single statement with its own `WHERE` clause. That is
 * the third acceptance criterion — no database transaction remains open
 * during scanning — expressed as a rule about how this service is written
 * rather than as something to remember: there is no method that opens a
 * transaction, so there is none that can leave one open across a scan.
 *
 * The alternative, a `SELECT ... FOR UPDATE` around the whole attempt, would
 * hold a row lock for as long as ClamAV takes on a ten-megabyte file. With a
 * connection pool sized for a web application and a scanner that can take a
 * minute, that is a pool exhaustion waiting for a slow upload.
 */
@Injectable()
export class FileScanAttemptService {
  private readonly _logger = new Logger(FileScanAttemptService.name);

  /**
   * Creates an instance of FileScanAttemptService.
   *
   * @param _repository - The attempt repository.
   * @param _settings - The worker's settings.
   */
  constructor(
    @InjectRepository(FileScanAttemptEntity)
    private readonly _repository: Repository<FileScanAttemptEntity>,
    @Inject(WORKER_SETTINGS) private readonly _settings: WorkerSettings,
  ) {}

  /**
   * Takes ownership of an attempt, or reports why it could not.
   *
   * One statement does the work. `INSERT ... ON CONFLICT DO UPDATE` against
   * the idempotency constraint either creates the attempt or takes over an
   * existing one whose lease has lapsed, and the `WHERE` on the update is
   * what stops it touching an attempt that has already answered or that
   * somebody else is holding. Two statements — look, then write — would have
   * a gap between them wide enough for two workers to both decide they had
   * won.
   *
   * @param request - The message that asked for the scan.
   * @param description - What the scanner says it is.
   * @returns What the claim found.
   */
  async claim(
    request: ScanRequestMessage,
    description: ScanEngineDescription,
  ): Promise<ClaimOutcome> {
    const leaseToken = randomUUID();
    const claimed = await this._repository.query(
      `INSERT INTO ${TABLE} (
         "assetId", "objectKey", "objectVersion", "expectedSha256",
         "policyVersion", "definitionEpoch", "campaignId", "traceId",
         "state", "engine", "engineVersion", "signatureVersion",
         "attemptCount", "leaseToken", "leaseExpiresAt", "heartbeatAt"
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'CLAIMED', $9, $10, $11,
               1, $12, now() + ($13 || ' milliseconds')::interval, now())
       ON CONFLICT ON CONSTRAINT "UQ_file_scan_attempt_idempotency"
       DO UPDATE SET
         "state" = 'CLAIMED',
         "engineVersion" = EXCLUDED."engineVersion",
         "signatureVersion" = EXCLUDED."signatureVersion",
         "attemptCount" = ${TABLE}."attemptCount" + 1,
         "leaseToken" = EXCLUDED."leaseToken",
         "leaseExpiresAt" = EXCLUDED."leaseExpiresAt",
         "heartbeatAt" = now(),
         "startedAt" = NULL
       WHERE ${TABLE}."state" IN ${OPEN_STATES}
         AND (${TABLE}."leaseExpiresAt" IS NULL
              OR ${TABLE}."leaseExpiresAt" < now())
         AND ${TABLE}."attemptCount" < $14
       RETURNING *`,
      [
        request.assetId,
        request.objectKey,
        request.objectVersion,
        request.expectedSha256,
        request.policyVersion,
        description.definitionEpoch,
        request.campaignId,
        request.traceId,
        description.engine,
        description.engineVersion,
        description.signatureVersion,
        leaseToken,
        String(this._settings.leaseMs),
        this._settings.maxAttempts,
      ],
    );

    if (claimed.length === 1) {
      return { kind: 'CLAIMED', attempt: claimed[0] as FileScanAttemptEntity };
    }

    return this.explainRefusedClaim(request, description);
  }

  /**
   * Records that the scanner has the bytes.
   *
   * @param attemptId - The attempt.
   * @param leaseToken - The token the claim issued.
   * @returns True when this worker still held the attempt.
   */
  async markScanning(attemptId: string, leaseToken: string): Promise<boolean> {
    const updated = await this.updateReturning(
      `UPDATE ${TABLE}
       SET "state" = 'SCANNING', "startedAt" = now(), "heartbeatAt" = now()
       WHERE "id" = $1 AND "leaseToken" = $2 AND "state" = 'CLAIMED'
       RETURNING "id"`,
      [attemptId, leaseToken],
    );

    return updated.length === 1;
  }

  /**
   * Extends a lease, so long as this worker still holds it.
   *
   * @param attemptId - The attempt.
   * @param leaseToken - The token the claim issued.
   * @returns True when the lease was extended.
   */
  async heartbeat(attemptId: string, leaseToken: string): Promise<boolean> {
    const updated = await this.updateReturning(
      `UPDATE ${TABLE}
       SET "heartbeatAt" = now(),
           "leaseExpiresAt" = now() + ($3 || ' milliseconds')::interval
       WHERE "id" = $1 AND "leaseToken" = $2 AND "state" IN ${OPEN_STATES}
       RETURNING "id"`,
      [attemptId, leaseToken, String(this._settings.leaseMs)],
    );

    return updated.length === 1;
  }

  /**
   * Writes the answer, if and only if this worker still owns the attempt.
   *
   * The compare-and-set the second acceptance criterion asks for. A worker
   * that stalled long enough to lose its lease updates no rows here, gets
   * null back, and says nothing — so its answer, which may be about bytes
   * that have since been replaced, never reaches the backend.
   *
   * The lease is cleared as part of the same statement. A finished attempt
   * holds no lease, so there is no token left that a second completion could
   * present.
   *
   * @param attemptId - The attempt.
   * @param leaseToken - The token the claim issued.
   * @param completion - How the attempt finished.
   * @returns The finished attempt, or null when the lease was lost.
   */
  async complete(
    attemptId: string,
    leaseToken: string,
    completion: AttemptCompletion,
  ): Promise<FileScanAttemptEntity | null> {
    const updated = await this.updateReturning(
      `UPDATE ${TABLE}
       SET "state" = $3,
           "observedSha256" = $4,
           "byteSize" = $5,
           "detectedContentType" = $6,
           "rejectionCode" = $7,
           "failureReason" = $8,
           "engineVersion" = $9,
           "signatureVersion" = $10,
           "completedAt" = now(),
           "leaseToken" = NULL,
           "leaseExpiresAt" = NULL
       WHERE "id" = $1 AND "leaseToken" = $2 AND "state" IN ${OPEN_STATES}
       RETURNING *`,
      [
        attemptId,
        leaseToken,
        completion.state,
        completion.observedSha256,
        completion.byteSize,
        completion.detectedContentType,
        completion.rejectionCode,
        completion.failureReason,
        completion.engineVersion,
        completion.signatureVersion,
      ],
    );

    if (updated.length === 0) {
      this._logger.warn(
        `[complete] Lease lost; saying nothing - AttemptId: ${attemptId}`,
      );

      return null;
    }

    return updated[0];
  }

  /**
   * Gives up a lease without finishing the attempt.
   *
   * What a graceful shutdown does. The attempt stays open and unleased, so
   * the next worker to be handed the message takes it immediately rather than
   * waiting out a lease that nobody is holding. The state is left where it
   * got to, because that is the truth about how far the last holder reached.
   *
   * @param attemptId - The attempt.
   * @param leaseToken - The token the claim issued.
   */
  async release(attemptId: string, leaseToken: string): Promise<void> {
    await this._repository.query(
      `UPDATE ${TABLE}
       SET "leaseToken" = NULL, "leaseExpiresAt" = NULL
       WHERE "id" = $1 AND "leaseToken" = $2 AND "state" IN ${OPEN_STATES}`,
      [attemptId, leaseToken],
    );
  }

  /**
   * Records that the verdict reached the queue.
   *
   * Written after the verdict is sent rather than before, so that a crash
   * between the two leaves a completed attempt marked unpublished. That is
   * recoverable; the reverse is a verdict nobody ever hears.
   *
   * @param attemptId - The attempt.
   */
  async markVerdictPublished(attemptId: string): Promise<void> {
    await this._repository.query(
      `UPDATE ${TABLE}
       SET "verdictPublishedAt" = now()
       WHERE "id" = $1 AND "verdictPublishedAt" IS NULL`,
      [attemptId],
    );
  }

  /**
   * Finds finished attempts whose verdict never reached the backend.
   *
   * ADR-0006 named the recovery this supports as the main new risk its
   * decision introduced: "Redis is not durable message history: the
   * authoritative state of every asset is the row in PostgreSQL, and a Redis
   * loss must be recoverable by re-enqueuing from that table."
   *
   * @param limit - The most to return.
   * @returns The attempts, oldest first.
   */
  async findUnpublishedVerdicts(
    limit: number,
  ): Promise<FileScanAttemptEntity[]> {
    return this._repository.query(
      `SELECT * FROM ${TABLE}
       WHERE "verdictPublishedAt" IS NULL AND "completedAt" IS NOT NULL
       ORDER BY "completedAt" ASC
       LIMIT $1`,
      [limit],
    );
  }

  /**
   * Works out why a claim did not take, and refuses the attempt when its
   * budget has run out.
   *
   * @param request - The message that asked for the scan.
   * @param description - What the scanner says it is.
   * @returns What the claim found.
   */
  private async explainRefusedClaim(
    request: ScanRequestMessage,
    description: ScanEngineDescription,
  ): Promise<ClaimOutcome> {
    const existing = await this._repository.findOne({
      where: {
        assetId: request.assetId,
        objectVersion: request.objectVersion ?? IsNull(),
        policyVersion: request.policyVersion,
        definitionEpoch: description.definitionEpoch,
      },
    });

    if (existing === null) {
      // The row was there when the insert conflicted and is not there now.
      // Only a delete between the two statements produces this, and the
      // honest answer is that somebody else is in the middle of something.
      return { kind: 'BUSY' };
    }

    if (existing.completedAt !== null) {
      return { kind: 'DUPLICATE', attempt: existing };
    }

    if (existing.attemptCount < this._settings.maxAttempts) {
      return { kind: 'BUSY' };
    }

    return this.refuseExhausted(existing);
  }

  /**
   * Closes an attempt that has been claimed too many times.
   *
   * Only when nobody is holding it. A worker that is part way through its
   * last permitted attempt is left to finish: refusing the row underneath it
   * would silence an answer that was about to arrive, and the point of the
   * budget is to stop attempts accumulating, not to interrupt one.
   *
   * @param existing - The attempt.
   * @returns What the claim found.
   */
  private async refuseExhausted(
    existing: FileScanAttemptEntity,
  ): Promise<ClaimOutcome> {
    const refused = await this.updateReturning(
      `UPDATE ${TABLE}
       SET "state" = 'REJECTED',
           "rejectionCode" = 'RETRY_BUDGET_EXHAUSTED',
           "failureReason" = $2,
           "completedAt" = now(),
           "leaseToken" = NULL,
           "leaseExpiresAt" = NULL
       WHERE "id" = $1 AND "state" IN ${OPEN_STATES}
         AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < now())
       RETURNING *`,
      [existing.id, `Claimed ${existing.attemptCount} times without an answer`],
    );

    if (refused.length === 0) {
      return { kind: 'BUSY' };
    }

    this._logger.warn(
      `[refuseExhausted] Retry budget spent - AttemptId: ${existing.id}`,
    );

    return { kind: 'EXHAUSTED', attempt: refused[0] };
  }

  /**
   * Runs an `UPDATE ... RETURNING` and gives back the rows it returned.
   *
   * TypeORM's PostgreSQL driver answers an `UPDATE` with `[rows, rowCount]`,
   * not with the rows as it does for an `INSERT` or a `SELECT`. Read as rows,
   * that pair always has a length of two, so every compare-and-set here
   * looked lost: `markScanning` said the lease had gone, and the attempt was
   * left `SCANNING` with nothing said to the backend.
   *
   * @param statement - The statement, which must be an `UPDATE`.
   * @param parameters - Its parameters.
   * @returns The rows the statement returned.
   */
  private async updateReturning(
    statement: string,
    parameters: unknown[],
  ): Promise<FileScanAttemptEntity[]> {
    const [rows] = (await this._repository.query(statement, parameters)) as [
      FileScanAttemptEntity[],
      number,
    ];

    return rows;
  }
}
