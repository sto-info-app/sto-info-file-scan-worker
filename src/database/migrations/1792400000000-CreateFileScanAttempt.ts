import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the worker's schema and its scan attempt record (FC-010).
 *
 * The first migration this repository has ever had. Until now the only table
 * it used, `upload_files`, existed because `TYPEORM_SYNCHRONIZE` created it,
 * which means its shape was whatever the entity happened to say on the day
 * the process last started. That is not a schema; it is a side effect.
 *
 * ## Why a separate schema
 *
 * ADR-0006 split migration ownership by table and warned that two owners
 * against one database "needs care: separate TypeORM migration tables, no
 * overlapping table names". Both repositories had in fact named their
 * migration table `_migrations`, so sharing a schema would have had each one
 * reading the other's history as its own. A schema of its own settles both
 * problems at once and costs a grant.
 *
 * ## Why the foreign key crosses the boundary
 *
 * ADR-0015 recorded, as its main new risk, that `upload_files` had no
 * `assetId` and that "until FC-010 does that work the two tables are
 * unrelated, and nothing enforces the relationship". A foreign key is the
 * enforcement. `ON DELETE RESTRICT`, because the registry row is what tells
 * the retention cron that an object exists, and an attempt that outlived it
 * would be a verdict about nothing.
 *
 * It does mean the backend's migrations must run first, which is a deploy
 * ordering this repository cannot check for itself. `docs/database.md`
 * records it.
 *
 * ## The three rules that are database rules
 *
 * **Duplicate deliveries collapse.** `UQ_file_scan_attempt_idempotency`
 * covers `(assetId, objectVersion, policyVersion, definitionEpoch)`, which is
 * ADR-0006 decision 4 verbatim. It is declared `NULLS NOT DISTINCT` because
 * R2 has no object versioning and every `objectVersion` in this table will be
 * null; under PostgreSQL's default those nulls differ from one another and
 * the constraint would silently have matched nothing.
 *
 * **A clean attempt cleared the bytes it was asked about.**
 * `CHK_file_scan_attempt_clean_hash` requires a `CLEAN` row to carry an
 * observed hash equal to the expected one. Service code could check this; a
 * constraint means no future code path can forget to. The explicit
 * `IS NOT NULL` in it is load-bearing: a null makes the comparison null
 * rather than false, and a CHECK accepts null, so without it the constraint
 * would have permitted the one row it exists to forbid.
 *
 * **A finished attempt is evidence.** `TR_file_scan_attempt_guard` refuses
 * every change to a terminal row except setting `verdictPublishedAt` once,
 * and refuses a change to the request's own fields at any time. This is the
 * schema half of "lost leases and stale completions cannot publish": the
 * compare-and-set on the lease token stops a stale worker writing, and this
 * stops anything else rewriting the answer afterwards.
 */
export class CreateFileScanAttempt1792400000000 implements MigrationInterface {
  name = 'CreateFileScanAttempt1792400000000';

  /**
   * Applies the migration to the database.
   *
   * @param queryRunner - The TypeORM query runner.
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "sto_info_worker"`);

    await queryRunner.query(
      `CREATE TYPE "sto_info_worker"."file_scan_attempt_state_enum" AS ENUM ` +
        `('CLAIMED', 'SCANNING', 'CLEAN', 'REJECTED', 'FAILED')`,
    );

    await queryRunner.query(`CREATE TABLE "sto_info_worker"."file_scan_attempt" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(),
      "assetId" uuid NOT NULL,
      "objectKey" varchar(1024) NOT NULL,
      "objectVersion" varchar(255),
      "expectedSha256" char(64) NOT NULL,
      "observedSha256" char(64),
      "byteSize" bigint,
      "detectedContentType" varchar(255),
      "policyVersion" int NOT NULL,
      "definitionEpoch" varchar(255) NOT NULL,
      "campaignId" uuid,
      "traceId" uuid NOT NULL,
      "state" "sto_info_worker"."file_scan_attempt_state_enum" NOT NULL,
      "rejectionCode" varchar(100),
      "failureReason" varchar(500),
      "engine" varchar(100) NOT NULL,
      "engineVersion" varchar(100),
      "signatureVersion" varchar(100),
      "attemptCount" int NOT NULL DEFAULT 0,
      "leaseToken" uuid,
      "leaseExpiresAt" timestamptz,
      "heartbeatAt" timestamptz,
      "startedAt" timestamptz,
      "completedAt" timestamptz,
      "verdictPublishedAt" timestamptz,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_file_scan_attempt" PRIMARY KEY ("id")
    )`);

    await queryRunner.query(
      `ALTER TABLE "sto_info_worker"."file_scan_attempt" ` +
        `ADD CONSTRAINT "FK_file_scan_attempt_asset" ` +
        `FOREIGN KEY ("assetId") REFERENCES "sto_info_app"."file_asset"("id") ` +
        `ON DELETE RESTRICT`,
    );

    await queryRunner.query(
      `ALTER TABLE "sto_info_worker"."file_scan_attempt" ` +
        `ADD CONSTRAINT "UQ_file_scan_attempt_idempotency" ` +
        `UNIQUE NULLS NOT DISTINCT ` +
        `("assetId", "objectVersion", "policyVersion", "definitionEpoch")`,
    );

    const checks: ReadonlyArray<readonly [string, string]> = [
      [
        'CHK_file_scan_attempt_expected_hash',
        `"expectedSha256" ~ '^[0-9a-f]{64}$'`,
      ],
      [
        'CHK_file_scan_attempt_observed_hash',
        `"observedSha256" IS NULL OR "observedSha256" ~ '^[0-9a-f]{64}$'`,
      ],
      [
        'CHK_file_scan_attempt_clean_hash',
        // `"observedSha256" = "expectedSha256"` alone is not enough, and the
        // rehearsal is what found it. A null observed hash makes that
        // comparison null rather than false, and a CHECK accepts null — so a
        // clean attempt that measured nothing at all would have been written
        // by a constraint that looks exactly like this one.
        `"state" <> 'CLEAN' OR ("observedSha256" IS NOT NULL ` +
          `AND "observedSha256" = "expectedSha256")`,
      ],
      [
        'CHK_file_scan_attempt_rejection_code',
        `("state" = 'REJECTED') = ("rejectionCode" IS NOT NULL)`,
      ],
      [
        'CHK_file_scan_attempt_byte_size',
        `"byteSize" IS NULL OR "byteSize" >= 0`,
      ],
      ['CHK_file_scan_attempt_attempt_count', `"attemptCount" >= 0`],
      [
        'CHK_file_scan_attempt_lease',
        `("leaseToken" IS NULL) = ("leaseExpiresAt" IS NULL)`,
      ],
      [
        'CHK_file_scan_attempt_completed',
        `("state" IN ('CLEAN', 'REJECTED', 'FAILED')) = ` +
          `("completedAt" IS NOT NULL)`,
      ],
      [
        'CHK_file_scan_attempt_terminal_lease',
        `"state" IN ('CLAIMED', 'SCANNING') OR "leaseToken" IS NULL`,
      ],
      [
        'CHK_file_scan_attempt_published',
        `"verdictPublishedAt" IS NULL OR "completedAt" IS NOT NULL`,
      ],
    ];

    for (const [name, expression] of checks) {
      await queryRunner.query(
        `ALTER TABLE "sto_info_worker"."file_scan_attempt" ` +
          `ADD CONSTRAINT "${name}" CHECK (${expression})`,
      );
    }

    await queryRunner.query(
      `CREATE INDEX "IDX_file_scan_attempt_asset" ` +
        `ON "sto_info_worker"."file_scan_attempt" ("assetId")`,
    );

    await queryRunner.query(
      `CREATE INDEX "IDX_file_scan_attempt_reclaim" ` +
        `ON "sto_info_worker"."file_scan_attempt" ("state", "leaseExpiresAt")`,
    );

    // A completed attempt whose verdict never reached the backend. The
    // recovery sweep ADR-0006 asks for reads exactly this, so it gets an
    // index of its own rather than a sequential scan over every attempt the
    // worker has ever made.
    await queryRunner.query(
      `CREATE INDEX "IDX_file_scan_attempt_unpublished" ` +
        `ON "sto_info_worker"."file_scan_attempt" ("completedAt") ` +
        `WHERE "verdictPublishedAt" IS NULL`,
    );

    await queryRunner.query(`
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
            OR NEW."signatureVersion" IS DISTINCT FROM OLD."signatureVersion"
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
    `);

    await queryRunner.query(`
      CREATE TRIGGER "TR_file_scan_attempt_guard"
      BEFORE UPDATE ON "sto_info_worker"."file_scan_attempt"
      FOR EACH ROW EXECUTE FUNCTION "sto_info_worker".file_scan_attempt_guard()
    `);
  }

  /**
   * Reverses the migration.
   *
   * The schema is left behind deliberately. TypeORM keeps this repository's
   * `_migrations` table inside it, so dropping the schema during a revert
   * would destroy the record of the revert as it happened. An empty schema
   * costs nothing.
   *
   * @param queryRunner - The TypeORM query runner.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "TR_file_scan_attempt_guard" ` +
        `ON "sto_info_worker"."file_scan_attempt"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "sto_info_worker".file_scan_attempt_guard()`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "sto_info_worker"."file_scan_attempt"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "sto_info_worker"."file_scan_attempt_state_enum"`,
    );
  }
}
