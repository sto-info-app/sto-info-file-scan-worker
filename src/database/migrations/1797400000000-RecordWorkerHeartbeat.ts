import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives every running worker a row that says it is alive, and whether it is
 * taking work (FC-042).
 *
 * ## Why a row
 *
 * Render never probes a background worker, so nothing outside the process
 * reads `/health/ready`. A worker that has paused itself because its scanner
 * is unfit therefore looks exactly like one with nothing to do: the queue
 * grows, nothing fails, and nobody is told. A row in the database the backend
 * already reads is the one place both sides can see.
 *
 * Each process writes its own row, keyed by an identifier it makes at start,
 * every `WORKER_HEARTBEAT_INTERVAL_MS`. The row says whether the process is
 * consuming (`RUNNING`), has stopped consuming because its scanner is unfit
 * (`PAUSED`, with a short reason code and the moment it first paused) or is
 * shutting down (`STOPPING`), which signatures it last saw, and how many jobs
 * it holds. A row whose `beatAt` is old belongs to a process that has gone.
 * Rows more than a day old are removed by the workers themselves, so a
 * crashed process does not linger for ever.
 *
 * ## The rules that are database rules
 *
 * - `state` is one of the three, and `pausedSince` is set exactly when it is
 *   `PAUSED`. The alert "paused for more than ten minutes" is read from it,
 *   so a paused row without it, or a running row with one, would be a wrong
 *   alert rather than a missing one.
 * - `pauseReason` is a short upper-case code and is only set on a paused
 *   row. It is shown to administrators, and a code cannot carry a file name,
 *   a path or anything else a free-text message might pick up.
 * - `jobsInHand` is never negative.
 *
 * ## What the backend may read
 *
 * As with the scan usage views, the backend reads a view rather than the
 * table: `worker_heartbeat_status`, with exactly the table's columns. **Its
 * column names are a contract with the backend's alerting**, which reads them
 * by name; the table can change underneath it and the view cannot.
 *
 * The grant names the backend's role, read from `BACKEND_DB_ROLE`, and the
 * migration refuses to run without it rather than create a view nothing can
 * read. `USAGE` on the schema is already the backend's, from
 * `1794800000000-RecordScanUsage`, so it is neither granted nor revoked here.
 *
 * The worker's own role needs no grant: it runs these migrations, so it owns
 * the table it creates, exactly as it owns `file_scan_attempt`.
 */
export class RecordWorkerHeartbeat1797400000000 implements MigrationInterface {
  name = 'RecordWorkerHeartbeat1797400000000';

  /**
   * Applies the migration to the database.
   *
   * @param queryRunner - The TypeORM query runner.
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    const backendRole = readBackendRole();

    await queryRunner.query(`CREATE TABLE "sto_info_worker"."worker_heartbeat" (
      "workerId" text NOT NULL,
      "state" text NOT NULL,
      "pauseReason" text,
      "definitionsVersion" text,
      "definitionsBuiltAt" timestamptz,
      "jobsInHand" integer NOT NULL DEFAULT 0,
      "startedAt" timestamptz NOT NULL,
      "beatAt" timestamptz NOT NULL,
      "pausedSince" timestamptz,
      CONSTRAINT "PK_worker_heartbeat" PRIMARY KEY ("workerId")
    )`);

    const checks: ReadonlyArray<readonly [string, string]> = [
      [
        'CHK_worker_heartbeat_state',
        `"state" IN ('RUNNING', 'PAUSED', 'STOPPING')`,
      ],
      [
        'CHK_worker_heartbeat_worker_id',
        `char_length("workerId") BETWEEN 1 AND 255`,
      ],
      [
        // Both sides are booleans that are never null, so this cannot pass
        // by comparing a null the way a CHECK on a nullable column would.
        'CHK_worker_heartbeat_paused_since',
        `("state" = 'PAUSED') = ("pausedSince" IS NOT NULL)`,
      ],
      [
        'CHK_worker_heartbeat_pause_reason',
        `"pauseReason" IS NULL OR ("state" = 'PAUSED' ` +
          `AND "pauseReason" ~ '^[A-Z][A-Z_]{0,63}$')`,
      ],
      ['CHK_worker_heartbeat_jobs_in_hand', `"jobsInHand" >= 0`],
    ];

    for (const [name, expression] of checks) {
      await queryRunner.query(
        `ALTER TABLE "sto_info_worker"."worker_heartbeat" ` +
          `ADD CONSTRAINT "${name}" CHECK (${expression})`,
      );
    }

    await queryRunner.query(`
      CREATE VIEW "sto_info_worker"."worker_heartbeat_status" AS
      SELECT
        h."workerId",
        h."state",
        h."pauseReason",
        h."definitionsVersion",
        h."definitionsBuiltAt",
        h."jobsInHand",
        h."startedAt",
        h."beatAt",
        h."pausedSince"
      FROM "sto_info_worker"."worker_heartbeat" h
    `);

    await queryRunner.query(
      `GRANT SELECT ON "sto_info_worker"."worker_heartbeat_status" ` +
        `TO "${backendRole}"`,
    );
  }

  /**
   * Reverses the migration.
   *
   * Dropping the view takes its grant with it. The rows go with the table,
   * which loses nothing: every running worker writes its row again at its
   * next beat once the migration is re-applied.
   *
   * @param queryRunner - The TypeORM query runner.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP VIEW IF EXISTS "sto_info_worker"."worker_heartbeat_status"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "sto_info_worker"."worker_heartbeat"`,
    );
  }
}

/** A PostgreSQL role name this migration is prepared to quote. */
const ROLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/**
 * Reads the backend's database role.
 *
 * Checked against a plain identifier pattern because it is interpolated into
 * a `GRANT`, which takes no parameters. A copy of the one in
 * `1794800000000-RecordScanUsage`, because a migration must not change when
 * another file does.
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
