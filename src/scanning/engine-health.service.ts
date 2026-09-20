import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { WORKER_SETTINGS, WorkerSettings } from '../config/worker-settings';
import {
  SCAN_ENGINE,
  ScanEngine,
  ScanEngineDescription,
} from './scan-engine.interface';

/** What the last question put to the scanner established. */
export interface EngineHealth {
  /** Whether this worker may scan anything at all. */
  readonly healthy: boolean;
  /** Why not, when it may not. Null while it may. */
  readonly reason: string | null;
  /**
   * What the scanner last said it was.
   *
   * Null until it has answered once, and null again once it stops
   * answering. Never a remembered description from before a failure: an
   * attempt records which signatures judged it, and the last good answer is
   * not evidence about the scanner that is running now.
   */
  readonly description: ScanEngineDescription | null;
  /** When the scanner was last asked. */
  readonly checkedAt: Date;
}

/** Told when the answer changes. */
export type EngineHealthListener = (health: EngineHealth) => void;

/**
 * Raised when a file arrives at a scanner that is not fit to judge it.
 *
 * Not a failure of the file and not recorded against it. Nothing has been
 * claimed when this is thrown, so the asset keeps its whole retry budget and
 * waits for a worker that can answer — ADR-0020.
 */
export class EngineUnfitError extends Error {
  /**
   * Creates an instance of EngineUnfitError.
   *
   * @param reason - What is wrong with the scanner.
   */
  constructor(reason: string) {
    super(reason);
    this.name = 'EngineUnfitError';
  }
}

/** What is reported before the scanner has ever been asked. */
const UNASKED: EngineHealth = {
  healthy: false,
  reason: 'The scanner has not been asked yet',
  description: null,
  checkedAt: new Date(0),
};

/**
 * Asks the scanner how it is, on a timer, so that nothing else has to.
 *
 * Before ADR-0020 the pipeline asked `describe()` once per job. That was
 * honest and it was also the wrong shape twice over: a round trip per file
 * for an answer that changes a few times a day, and — because the answer
 * arrived inside the job — a worker with a broken scanner still took the
 * job, wrote an attempt row and spent one of that asset's three tries. Three
 * deliveries during a `freshclam` outage and a perfectly good upload was
 * rejected for good, by us.
 *
 * So the question is asked here instead, on an interval, and the answer is
 * read rather than asked for. Two things act on it. The processor pauses the
 * queue while the answer is no, so jobs wait instead of failing. The
 * pipeline refuses before it claims anything, so a job that slipped through
 * the gap between a health check and a pause still costs the asset nothing.
 *
 * What counts as healthy is ADR-0005 decision 4, unchanged: a scanner that
 * cannot be reached, one that will not say how old its signatures are, and
 * one whose signatures are older than the policy allows are all equally
 * unfit to judge a file. Silence is not freshness.
 */
@Injectable()
export class EngineHealthService implements OnModuleInit, OnModuleDestroy {
  private readonly _logger = new Logger(EngineHealthService.name);

  private readonly _listeners: EngineHealthListener[] = [];

  private _health: EngineHealth = UNASKED;

  private _timer: NodeJS.Timeout | null = null;

  private _inFlight: Promise<EngineHealth> | null = null;

  /**
   * Creates an instance of EngineHealthService.
   *
   * @param _engine - The scanner.
   * @param _settings - The worker's settings.
   */
  constructor(
    @Inject(SCAN_ENGINE) private readonly _engine: ScanEngine,
    @Inject(WORKER_SETTINGS) private readonly _settings: WorkerSettings,
  ) {}

  /**
   * Asks once, then keeps asking.
   *
   * The first question is awaited so that nothing starts consuming before
   * the answer is known. It cannot fail startup: a container whose `clamd`
   * is still loading its signatures is starting normally, and the right
   * response to it is an unready worker that scans nothing, not a process
   * that refuses to run.
   */
  async onModuleInit(): Promise<void> {
    await this.check();

    this._timer = setInterval(() => {
      void this.check();
    }, this._settings.healthPollMs);

    this._timer.unref?.();
  }

  /** Stops asking. */
  onModuleDestroy(): void {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Reports the last answer without asking again.
   *
   * @returns What the scanner last established.
   */
  current(): EngineHealth {
    return this._health;
  }

  /**
   * Registers something to be told when the answer changes.
   *
   * Only on a change, and not on every check: the listener's job is to pause
   * and resume a queue, and doing either thing repeatedly because nothing
   * happened is how a log becomes unreadable.
   *
   * @param listener - What to tell.
   */
  onChange(listener: EngineHealthListener): void {
    this._listeners.push(listener);
  }

  /**
   * Asks the scanner now.
   *
   * Overlapping calls share one conversation. A `describe` that takes longer
   * than the poll interval would otherwise start a second one beside it, and
   * two answers racing to be stored is a worse problem than a late answer.
   *
   * @returns What it established.
   */
  async check(): Promise<EngineHealth> {
    this._inFlight ??= this.ask().finally(() => {
      this._inFlight = null;
    });

    return this._inFlight;
  }

  /**
   * Puts the question, and records what came back.
   *
   * @returns What it established.
   */
  private async ask(): Promise<EngineHealth> {
    let description: ScanEngineDescription;

    try {
      description = await this._engine.describe();
    } catch {
      return this.record({
        healthy: false,
        reason: 'The scanner cannot be reached',
        description: null,
        checkedAt: new Date(),
      });
    }

    return this.record({
      ...this.judge(description),
      description,
      checkedAt: new Date(),
    });
  }

  /**
   * Decides whether a scanner that answered is fit to judge a file.
   *
   * @param description - What it said it was.
   * @returns The verdict on the scanner itself.
   */
  private judge(description: ScanEngineDescription): {
    healthy: boolean;
    reason: string | null;
  } {
    if (description.definitionsBuiltAt === null) {
      return {
        healthy: false,
        reason: 'The scanner did not say how old its signatures are',
      };
    }

    const age = Date.now() - description.definitionsBuiltAt.getTime();

    if (age > this._settings.maxDefinitionAgeMs) {
      return {
        healthy: false,
        reason: 'The signature database is older than the policy allows',
      };
    }

    return { healthy: true, reason: null };
  }

  /**
   * Stores an answer and announces it if it is news.
   *
   * @param health - The answer.
   * @returns The same answer.
   */
  private record(health: EngineHealth): EngineHealth {
    const changed = health.healthy !== this._health.healthy;

    this._health = health;

    if (!changed) {
      return health;
    }

    if (health.healthy) {
      this._logger.log('[record] The scanner is fit to judge files again');
    } else {
      this._logger.error(`[record] The scanner is unfit - ${health.reason}`);
    }

    for (const listener of this._listeners) {
      listener(health);
    }

    return health;
  }
}
