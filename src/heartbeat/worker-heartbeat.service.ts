import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';

import { DataSource } from 'typeorm';

import {
  WORKER_DATABASE_SCHEMA,
  WORKER_SETTINGS,
  WorkerSettings,
} from '../config/worker-settings';
import {
  ENGINE_UNFIT_REASONS,
  EngineHealth,
  EngineHealthService,
} from '../scanning/engine-health.service';

/** The fully qualified table this service writes. */
const TABLE = `"${WORKER_DATABASE_SCHEMA}"."worker_heartbeat"`;

/** What a worker is doing, as its heartbeat row says. */
export type WorkerState = 'RUNNING' | 'PAUSED' | 'STOPPING';

/**
 * The pause reason written when the scanner's reason is not one this build
 * has a code for. Only a new reason added without a code produces it.
 */
export const UNKNOWN_PAUSE_REASON = 'UNKNOWN';

/**
 * Writes this process's row, or brings it up to date.
 *
 * Every instant but `startedAt` is the database's own clock, which is the
 * clock the backend's "how long ago" is measured by. `pausedSince` survives a
 * beat that is still paused and is cleared by one that is not, so it is when
 * the pause began however many beats have happened since.
 */
export const HEARTBEAT_UPSERT = `
  INSERT INTO ${TABLE} AS h (
    "workerId", "state", "pauseReason", "definitionsVersion",
    "definitionsBuiltAt", "jobsInHand", "startedAt", "beatAt", "pausedSince"
  )
  VALUES (
    $1::text, $2::text, $3::text, $4::text, $5::timestamptz, $6::int,
    $7::timestamptz, now(), CASE WHEN $2::text = 'PAUSED' THEN now() END
  )
  ON CONFLICT ("workerId") DO UPDATE SET
    "state" = EXCLUDED."state",
    "pauseReason" = EXCLUDED."pauseReason",
    "definitionsVersion" = EXCLUDED."definitionsVersion",
    "definitionsBuiltAt" = EXCLUDED."definitionsBuiltAt",
    "jobsInHand" = EXCLUDED."jobsInHand",
    "beatAt" = EXCLUDED."beatAt",
    "pausedSince" = CASE WHEN EXCLUDED."state" = 'PAUSED'
      THEN coalesce(h."pausedSince", EXCLUDED."pausedSince") END`;

/**
 * Removes the rows of processes that have not beaten for a day.
 *
 * A worker that crashed or was replaced never writes `STOPPING`, and its row
 * would otherwise stay for ever. A day is long enough that the backend has
 * long since called it silent, and short enough that the table only ever
 * holds a handful of rows.
 */
export const HEARTBEAT_PRUNE = `
  DELETE FROM ${TABLE} WHERE "beatAt" < now() - interval '24 hours'`;

/** What the heartbeat needs to know about the consumer it reports on. */
export interface WorkerActivity {
  /** Whether this process has stopped taking scan requests. */
  isPaused(): boolean;
  /** How many jobs this process is working on right now. */
  jobsInHand(): number;
}

/**
 * Makes an identifier for this process, once.
 *
 * The host name says which container, the process id which process in it,
 * and the random suffix keeps two processes apart when a restarted container
 * is given the same host name and pid as the one before it. The host name is
 * cut short so the whole always fits the column's limit.
 *
 * @returns The identifier.
 */
export function workerIdentifier(): string {
  return `${hostname().slice(0, 200)}:${process.pid}:${randomUUID().slice(0, 8)}`;
}

/**
 * Turns why the scanner is unfit into the code the heartbeat reports.
 *
 * @param health - What the scanner last said about itself.
 * @returns The code, or null when the scanner is fit.
 */
export function pauseReasonCode(health: EngineHealth): string | null {
  if (health.healthy) {
    return null;
  }

  const entry = Object.entries(ENGINE_UNFIT_REASONS).find(
    ([, reason]) => reason === health.reason,
  );

  return entry?.[0] ?? UNKNOWN_PAUSE_REASON;
}

/**
 * Tells the backend this worker is alive, and whether it is taking work
 * (FC-042).
 *
 * Render never probes a background worker, so a worker that has paused
 * itself because its scanner is unfit is indistinguishable from outside from
 * one with nothing to do. This writes one row per process into
 * `worker_heartbeat` — on start, every `WORKER_HEARTBEAT_INTERVAL_MS`, as
 * soon as the scanner's health changes, and once more as `STOPPING` on the
 * way out — and the backend reads it through `worker_heartbeat_status`.
 *
 * **It can never stop scanning.** A beat that fails is logged and the next
 * one tries again; nothing here throws into the processor, and a database
 * that has gone away costs a log line every interval rather than a worker.
 *
 * It is started by the processor rather than by Nest, because the processor
 * is what it reports on and is not ready until its BullMQ worker exists.
 */
@Injectable()
export class WorkerHeartbeatService implements BeforeApplicationShutdown {
  private readonly _logger = new Logger(WorkerHeartbeatService.name);

  private readonly _workerId = workerIdentifier();

  private readonly _startedAt = new Date();

  private _activity: WorkerActivity | null = null;

  private _timer: NodeJS.Timeout | null = null;

  private _inFlight: Promise<void> | null = null;

  private _again = false;

  private _stopping = false;

  private _announced = false;

  /**
   * Creates an instance of WorkerHeartbeatService.
   *
   * @param _dataSource - The database.
   * @param _health - What the scanner last said about itself.
   * @param _settings - The worker's settings.
   */
  constructor(
    private readonly _dataSource: DataSource,
    private readonly _health: EngineHealthService,
    @Inject(WORKER_SETTINGS) private readonly _settings: WorkerSettings,
  ) {}

  /**
   * The identifier this process's row is written under.
   *
   * @returns The identifier.
   */
  get workerId(): string {
    return this._workerId;
  }

  /**
   * Starts beating, for the consumer given.
   *
   * A second call is ignored: there is one row per process, and a second
   * timer would only write it twice as often.
   *
   * @param activity - The consumer to report on.
   */
  start(activity: WorkerActivity): void {
    if (this._activity !== null) {
      return;
    }

    this._activity = activity;

    // Registered after the processor's own listener, so by the time this
    // beats the queue has already been told to pause or resume.
    this._health.onChange(() => {
      void this.beat();
    });

    void this.beat();

    this._timer = setInterval(() => {
      void this.beat();
    }, this._settings.workerHeartbeatIntervalMs);

    this._timer.unref?.();
  }

  /**
   * Writes the row now.
   *
   * Never overlaps itself. A beat asked for while one is being written is
   * written straight afterwards, once, with whatever is true by then — so a
   * pause that lands mid-write is not lost until the next interval, and a
   * slow database does not collect a queue of beats.
   *
   * @returns When the row is up to date, or the attempt has been logged.
   */
  beat(): Promise<void> {
    if (this._inFlight !== null) {
      this._again = true;

      return this._inFlight;
    }

    this._inFlight = this.beatUntilCurrent().finally(() => {
      this._inFlight = null;
    });

    return this._inFlight;
  }

  /**
   * Stops beating, and says so.
   *
   * Before the application shuts down rather than as it does, because the
   * database connection and the BullMQ worker both close in the shutdown
   * hook itself. The row therefore reads `STOPPING` while any job in hand
   * finishes, which is what it is.
   */
  async beforeApplicationShutdown(): Promise<void> {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }

    if (this._activity === null) {
      return;
    }

    this._stopping = true;

    await this.beat();
  }

  /**
   * Writes until nothing more has been asked for.
   *
   * @returns When the last write has been made or logged.
   */
  private async beatUntilCurrent(): Promise<void> {
    do {
      this._again = false;
      await this.write();
    } while (this._again);
  }

  /**
   * Writes the row once, and removes the rows of processes long gone.
   *
   * @returns When both statements have run, or the failure has been logged.
   */
  private async write(): Promise<void> {
    try {
      const activity = this._activity as WorkerActivity;
      const health = this._health.current();
      const state = this.stateOf(activity);

      await this._dataSource.query(HEARTBEAT_UPSERT, [
        this._workerId,
        state,
        state === 'PAUSED' ? pauseReasonCode(health) : null,
        health.description?.signatureVersion ?? null,
        health.description?.definitionsBuiltAt ?? null,
        activity.jobsInHand(),
        this._startedAt,
      ]);
      await this._dataSource.query(HEARTBEAT_PRUNE);

      if (!this._announced) {
        this._announced = true;
        this._logger.log(
          `[write] Heartbeat recorded - WorkerId: ${this._workerId}`,
        );
      }
    } catch (error) {
      this._logger.error(
        `[write] Heartbeat not recorded - WorkerId: ${this._workerId}, ` +
          `Reason: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }

  /**
   * Works out what the row should say this process is doing.
   *
   * @param activity - The consumer reported on.
   * @returns The state.
   */
  private stateOf(activity: WorkerActivity): WorkerState {
    if (this._stopping) {
      return 'STOPPING';
    }

    return activity.isPaused() ? 'PAUSED' : 'RUNNING';
  }
}
