import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets an attempt that failed be reopened, or closed for good (FC-042).
 *
 * ## Why
 *
 * An attempt that finished `FAILED` met a transient fault — a scanner that
 * went away mid-scan, a bucket that would not answer — and told the backend
 * `RETRY`. Nothing ever retried it. The idempotency constraint gives one row
 * per asset, object version, policy and signature epoch, the guard trigger
 * made a finished row immutable, and so every later request for the same
 * question was answered from the row: `RETRY`, again, until the signatures
 * changed. With the backend's re-queue sweep asking every few minutes, that
 * is an upload asked about all day and never scanned.
 *
 * Steve's decision is **reopen, then refuse**. A new request for an attempt
 * that failed reopens it — a genuine new scan — while it is under its budget
 * (`SCAN_MAX_ATTEMPTS`, counted in claims); once the budget is spent it is
 * closed with the existing final refusal, `RETRY_BUDGET_EXHAUSTED`, so the
 * backend refuses the upload and stops asking.
 *
 * ## What the guard now allows, and only this
 *
 * Every other rule stands: what was asked is never changed, `CLEAN` and
 * `REJECTED` are final, and a published verdict is never published again.
 * From `FAILED`, exactly two moves are added.
 *
 * - **Reopen, to `CLAIMED`.** One more claim and a fresh lease, and nothing
 *   of the old answer left: no completion, no start, no observed hash, size,
 *   type, code or reason, and no record that a verdict was sent, since the
 *   new answer must be. The scanner's versions may change, because a new
 *   claim records the scanner that took it.
 * - **Refuse, to `REJECTED`.** With `RETRY_BUDGET_EXHAUSTED` and nothing
 *   else: the same claims, a new completion, no lease, nothing about the
 *   bytes or the scanner changed, and the sent-record cleared, since the
 *   refusal is a new answer to send.
 *
 * The budget itself is a setting the database cannot see, so the service's
 * statements enforce it (`attemptCount < SCAN_MAX_ATTEMPTS` to reopen); the
 * trigger enforces the shape. The lease's compare-and-set is untouched: a
 * worker still holding a token from before the failure finds it gone, since
 * a finished attempt holds no lease and a reopened one holds a new one.
 *
 * The function is written out whole, as `1794800000000-RecordScanUsage`
 * wrote it, because a trigger function is replaced whole. `down` puts that
 * version back.
 */
export class ReopenFailedScanAttempt1797500000000 implements MigrationInterface {
  name = 'ReopenFailedScanAttempt1797500000000';

  /**
   * Applies the migration to the database.
   *
   * @param queryRunner - The TypeORM query runner.
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(guardFunction(true));
  }

  /**
   * Reverses the migration.
   *
   * Restores the guard that refuses every change to a finished attempt. Rows
   * reopened in the meantime need nothing undone: each is either open or
   * finished, and both are shapes the restored guard already knows.
   *
   * @param queryRunner - The TypeORM query runner.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(guardFunction(false));
  }
}

/**
 * The guard trigger's function, with or without the two moves from `FAILED`.
 *
 * @param withReopen - Whether a failed attempt may be reopened or refused.
 * @returns The `CREATE OR REPLACE FUNCTION` statement.
 */
function guardFunction(withReopen: boolean): string {
  const fromFailed = withReopen
    ? `

        IF OLD."state" = 'FAILED' AND NEW."state" = 'CLAIMED' THEN
          IF NEW."attemptCount" IS DISTINCT FROM OLD."attemptCount" + 1
            OR NEW."leaseToken" IS NULL
            OR NEW."completedAt" IS NOT NULL
            OR NEW."startedAt" IS NOT NULL
            OR NEW."verdictPublishedAt" IS NOT NULL
            OR NEW."observedSha256" IS NOT NULL
            OR NEW."byteSize" IS NOT NULL
            OR NEW."detectedContentType" IS NOT NULL
            OR NEW."rejectionCode" IS NOT NULL
            OR NEW."failureReason" IS NOT NULL
            OR NEW."engine" IS DISTINCT FROM OLD."engine" THEN
            RAISE EXCEPTION
              'A failed scan attempt can only be reopened as a fresh claim';
          END IF;

          RETURN NEW;
        END IF;

        IF OLD."state" = 'FAILED' AND NEW."state" = 'REJECTED' THEN
          IF NEW."rejectionCode" IS DISTINCT FROM 'RETRY_BUDGET_EXHAUSTED'
            OR NEW."attemptCount" IS DISTINCT FROM OLD."attemptCount"
            OR NEW."completedAt" IS NULL
            OR NEW."leaseToken" IS NOT NULL
            OR NEW."verdictPublishedAt" IS NOT NULL
            OR NEW."observedSha256" IS DISTINCT FROM OLD."observedSha256"
            OR NEW."byteSize" IS DISTINCT FROM OLD."byteSize"
            OR NEW."detectedContentType" IS DISTINCT FROM
              OLD."detectedContentType"
            OR NEW."engine" IS DISTINCT FROM OLD."engine"
            OR NEW."engineVersion" IS DISTINCT FROM OLD."engineVersion"
            OR NEW."signatureVersion" IS DISTINCT FROM OLD."signatureVersion"
            OR NEW."definitionsBuiltAt" IS DISTINCT FROM
              OLD."definitionsBuiltAt"
            OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt" THEN
            RAISE EXCEPTION
              'A failed scan attempt can only be closed by refusing it for its spent budget';
          END IF;

          RETURN NEW;
        END IF;`
    : '';

  return `
      CREATE OR REPLACE FUNCTION "sto_info_worker".file_scan_attempt_guard()
      RETURNS trigger AS $$
      BEGIN
        IF NEW."assetId" IS DISTINCT FROM OLD."assetId"
          OR NEW."objectKey" IS DISTINCT FROM OLD."objectKey"
          OR NEW."objectVersion" IS DISTINCT FROM OLD."objectVersion"
          OR NEW."expectedSha256" IS DISTINCT FROM OLD."expectedSha256"
          OR NEW."policyVersion" IS DISTINCT FROM OLD."policyVersion"
          OR NEW."definitionEpoch" IS DISTINCT FROM OLD."definitionEpoch"
          OR NEW."campaignId" IS DISTINCT FROM OLD."campaignId"
          OR NEW."traceId" IS DISTINCT FROM OLD."traceId"
          OR NEW."requestedAt" IS DISTINCT FROM OLD."requestedAt"
          OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
          RAISE EXCEPTION
            'A scan attempt cannot change what it was asked to scan';
        END IF;${fromFailed}

        IF OLD."state" IN ('CLEAN', 'REJECTED', 'FAILED') THEN
          IF NEW."state" IS DISTINCT FROM OLD."state"
            OR NEW."observedSha256" IS DISTINCT FROM OLD."observedSha256"
            OR NEW."byteSize" IS DISTINCT FROM OLD."byteSize"
            OR NEW."detectedContentType" IS DISTINCT FROM
              OLD."detectedContentType"
            OR NEW."rejectionCode" IS DISTINCT FROM OLD."rejectionCode"
            OR NEW."failureReason" IS DISTINCT FROM OLD."failureReason"
            OR NEW."engine" IS DISTINCT FROM OLD."engine"
            OR NEW."engineVersion" IS DISTINCT FROM OLD."engineVersion"
            OR NEW."signatureVersion" IS DISTINCT FROM OLD."signatureVersion"
            OR NEW."definitionsBuiltAt" IS DISTINCT FROM
              OLD."definitionsBuiltAt"
            OR NEW."completedAt" IS DISTINCT FROM OLD."completedAt"
            OR NEW."attemptCount" IS DISTINCT FROM OLD."attemptCount"
            OR NEW."leaseToken" IS DISTINCT FROM OLD."leaseToken"
            OR NEW."leaseExpiresAt" IS DISTINCT FROM OLD."leaseExpiresAt"
            OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt" THEN
            RAISE EXCEPTION 'A finished scan attempt cannot be changed';
          END IF;

          IF OLD."verdictPublishedAt" IS NOT NULL
            AND NEW."verdictPublishedAt" IS DISTINCT FROM
              OLD."verdictPublishedAt" THEN
            RAISE EXCEPTION 'A published verdict cannot be published again';
          END IF;
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `;
}
