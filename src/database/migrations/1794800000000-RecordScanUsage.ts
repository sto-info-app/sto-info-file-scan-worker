import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records what the scan usage figures need, and shows the backend only the
 * totals (FC-003).
 *
 * ## Two new facts on every attempt
 *
 * `requestedAt` is when the backend queued the request, taken from the job
 * itself. Without it the only start this table knows is the moment a worker
 * picked the job up, so a queue that sat full for an hour would look like a
 * fast scanner. `definitionsBuiltAt` is when the signature database was
 * built, which `clamd` reports alongside its version; it is what "how old
 * were the signatures" is answered from.
 *
 * Both are evidence, so the guard trigger learns about them.
 * `requestedAt` joins the request's fields, which no update may change.
 * `definitionsBuiltAt` joins the answer's fields, which a finished attempt
 * may not change.
 *
 * ## Two views, and nothing else, for the backend
 *
 * ADR-0019 gave the backend no `SELECT` in this schema, and the table holds
 * asset identifiers, object keys and hashes. The admin diagnostics page needs
 * none of those, so it gets two views that carry only totals: `scan_usage`,
 * one row for each of three windows, and `scan_engine_status`, the engine
 * the latest attempt reported. The views are the contract; the table can
 * change underneath them.
 *
 * The grant names the backend's role, which only the deployment knows, so
 * it is read from `BACKEND_DB_ROLE`. The migration refuses to run without it
 * rather than create views nothing can read.
 *
 * ## What counts as what
 *
 * - **A re-scan** is an attempt that belongs to a campaign, or any attempt
 *   for an asset that already had one — the same bytes under newer
 *   definitions or a newer policy. Everything else is an initial scan.
 * - **A retry** is a claim beyond the first. `attemptCount` counts claims,
 *   so an attempt claimed three times holds two retries.
 * - **Scan time** runs from the scanner getting the bytes to the answer.
 *   **Wait** runs from the request being queued to the answer.
 * - **A window** holds the attempts the worker took within it.
 */
export class RecordScanUsage1794800000000 implements MigrationInterface {
  name = 'RecordScanUsage1794800000000';

  /**
   * Applies the migration to the database.
   *
   * @param queryRunner - The TypeORM query runner.
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    const backendRole = readBackendRole();

    await queryRunner.query(
      `ALTER TABLE "sto_info_worker"."file_scan_attempt" ` +
        `ADD "requestedAt" timestamptz, ` +
        `ADD "definitionsBuiltAt" timestamptz`,
    );

    await queryRunner.query(guardFunction(true));

    await queryRunner.query(`
      CREATE VIEW "sto_info_worker"."scan_usage" AS
      WITH "windows" ("window", "since", "position") AS (
        VALUES
          ('24h', now() - interval '24 hours', 1),
          ('7d', now() - interval '7 days', 2),
          ('30d', now() - interval '30 days', 3)
      ),
      "attempts" AS (
        SELECT
          a."state",
          a."rejectionCode",
          a."attemptCount",
          a."createdAt",
          a."campaignId" IS NOT NULL
            OR row_number() OVER (
              PARTITION BY a."assetId" ORDER BY a."createdAt", a."id"
            ) > 1 AS "isRescan",
          extract(epoch FROM a."completedAt" - a."startedAt") * 1000
            AS "scanMs",
          extract(epoch FROM a."completedAt" - a."requestedAt") * 1000
            AS "waitMs"
        FROM "sto_info_worker"."file_scan_attempt" a
      )
      SELECT
        w."window",
        w."position",
        count(*) FILTER (WHERE NOT t."isRescan")::int AS "initialScans",
        count(*) FILTER (WHERE t."isRescan")::int AS "rescans",
        count(*) FILTER (WHERE t."attemptCount" > 1)::int AS "retriedScans",
        coalesce(
          sum(t."attemptCount" - 1) FILTER (WHERE t."attemptCount" > 1), 0
        )::int AS "retries",
        count(*) FILTER (WHERE t."state" = 'CLEAN')::int AS "clean",
        count(*) FILTER (WHERE t."rejectionCode" = 'INFECTED')::int
          AS "infected",
        count(*) FILTER (WHERE t."rejectionCode" = 'UNSUPPORTED_PAYLOAD')::int
          AS "unsupported",
        count(*) FILTER (WHERE t."rejectionCode" = 'CONTENT_TYPE_MISMATCH')::int
          AS "contentTypeMismatch",
        count(*) FILTER (WHERE t."rejectionCode" = 'SIZE_LIMIT_EXCEEDED')::int
          AS "tooLarge",
        count(*) FILTER (WHERE t."rejectionCode" = 'HASH_MISMATCH')::int
          AS "hashMismatch",
        count(*) FILTER (WHERE t."rejectionCode" = 'OBJECT_MISSING')::int
          AS "objectMissing",
        count(*) FILTER (WHERE t."rejectionCode" = 'RETRY_BUDGET_EXHAUSTED')::int
          AS "retriesExhausted",
        count(*) FILTER (WHERE t."state" = 'FAILED')::int AS "failed",
        count(*) FILTER (WHERE t."state" IN ('CLAIMED', 'SCANNING'))::int
          AS "inProgress",
        round(percentile_cont(0.5) WITHIN GROUP (ORDER BY t."scanMs")
          FILTER (WHERE t."scanMs" IS NOT NULL))::int AS "scanMedianMs",
        round(percentile_cont(0.95) WITHIN GROUP (ORDER BY t."scanMs")
          FILTER (WHERE t."scanMs" IS NOT NULL))::int AS "scanP95Ms",
        round(max(t."scanMs"))::int AS "scanMaxMs",
        round(percentile_cont(0.5) WITHIN GROUP (ORDER BY t."waitMs")
          FILTER (WHERE t."waitMs" IS NOT NULL))::int AS "waitMedianMs",
        round(percentile_cont(0.95) WITHIN GROUP (ORDER BY t."waitMs")
          FILTER (WHERE t."waitMs" IS NOT NULL))::int AS "waitP95Ms",
        round(max(t."waitMs"))::int AS "waitMaxMs"
      FROM "windows" w
      LEFT JOIN "attempts" t ON t."createdAt" >= w."since"
      GROUP BY w."window", w."position"
    `);

    await queryRunner.query(`
      CREATE VIEW "sto_info_worker"."scan_engine_status" AS
      SELECT
        a."engine",
        a."engineVersion",
        a."signatureVersion",
        a."definitionsBuiltAt",
        coalesce(a."completedAt", a."createdAt") AS "reportedAt"
      FROM "sto_info_worker"."file_scan_attempt" a
      ORDER BY coalesce(a."completedAt", a."createdAt") DESC, a."id" DESC
      LIMIT 1
    `);

    await queryRunner.query(
      `GRANT USAGE ON SCHEMA "sto_info_worker" TO "${backendRole}"`,
    );
    await queryRunner.query(
      `GRANT SELECT ON "sto_info_worker"."scan_usage", ` +
        `"sto_info_worker"."scan_engine_status" TO "${backendRole}"`,
    );
  }

  /**
   * Reverses the migration.
   *
   * Dropping the views takes their grants with them. The schema grant does
   * not go on its own, so it is revoked by name.
   *
   * @param queryRunner - The TypeORM query runner.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const backendRole = readBackendRole();

    await queryRunner.query(
      `DROP VIEW IF EXISTS "sto_info_worker"."scan_engine_status"`,
    );
    await queryRunner.query(
      `DROP VIEW IF EXISTS "sto_info_worker"."scan_usage"`,
    );
    await queryRunner.query(
      `REVOKE USAGE ON SCHEMA "sto_info_worker" FROM "${backendRole}"`,
    );
    await queryRunner.query(guardFunction(false));
    await queryRunner.query(
      `ALTER TABLE "sto_info_worker"."file_scan_attempt" ` +
        `DROP COLUMN "definitionsBuiltAt", DROP COLUMN "requestedAt"`,
    );
  }
}

/** A PostgreSQL role name this migration is prepared to quote. */
const ROLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/**
 * Reads the backend's database role.
 *
 * Checked against a plain identifier pattern because it is interpolated into
 * a `GRANT`, which takes no parameters.
 *
 * @returns The role name.
 * @throws Error when it is missing or is not a plain identifier.
 */
function readBackendRole(): string {
  const role = process.env.BACKEND_DB_ROLE?.trim() ?? '';

  if (!ROLE_NAME.test(role)) {
    throw new Error(
      'BACKEND_DB_ROLE must name the database role the backend connects as, ' +
        'as a plain identifier',
    );
  }

  return role;
}

/**
 * The guard trigger's function, with or without the two columns this
 * migration adds.
 *
 * Written out whole rather than patched, because a trigger function is
 * replaced whole. The version without them is exactly what
 * `1792400000000-CreateFileScanAttempt` created, so a revert restores it.
 *
 * @param withUsage - Whether to guard `requestedAt` and `definitionsBuiltAt`.
 * @returns The `CREATE OR REPLACE FUNCTION` statement.
 */
function guardFunction(withUsage: boolean): string {
  const requestField = withUsage
    ? `
          OR NEW."requestedAt" IS DISTINCT FROM OLD."requestedAt"`
    : '';
  const answerField = withUsage
    ? `
            OR NEW."definitionsBuiltAt" IS DISTINCT FROM
              OLD."definitionsBuiltAt"`
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
          OR NEW."traceId" IS DISTINCT FROM OLD."traceId"${requestField}
          OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
          RAISE EXCEPTION
            'A scan attempt cannot change what it was asked to scan';
        END IF;

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
            OR NEW."signatureVersion" IS DISTINCT FROM OLD."signatureVersion"${answerField}
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
