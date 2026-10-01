import { hostname } from 'node:os';

import { Logger } from '@nestjs/common';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { DataSource } from 'typeorm';

import { WorkerSettings } from '../config/worker-settings';
import {
  ENGINE_UNFIT_REASONS,
  EngineHealth,
  EngineHealthListener,
  EngineHealthService,
} from '../scanning/engine-health.service';
import {
  HEARTBEAT_PRUNE,
  HEARTBEAT_UPSERT,
  pauseReasonCode,
  UNKNOWN_PAUSE_REASON,
  WorkerActivity,
  WorkerHeartbeatService,
  workerIdentifier,
} from './worker-heartbeat.service';

const SETTINGS = {
  workerHeartbeatIntervalMs: 30_000,
} as WorkerSettings;

const BUILT_AT = new Date('2026-09-30T06:00:00.000Z');

const FIT: EngineHealth = {
  healthy: true,
  reason: null,
  description: {
    engine: 'clamav',
    engineVersion: '1.4.3',
    signatureVersion: '27412',
    definitionEpoch: '27412',
    definitionsBuiltAt: BUILT_AT,
  },
  checkedAt: new Date(),
};

const UNREACHABLE: EngineHealth = {
  healthy: false,
  reason: ENGINE_UNFIT_REASONS.SCANNER_UNREACHABLE,
  description: null,
  checkedAt: new Date(),
};

/** The parameters of one upsert, by name. */
interface Beat {
  readonly workerId: unknown;
  readonly state: unknown;
  readonly pauseReason: unknown;
  readonly definitionsVersion: unknown;
  readonly definitionsBuiltAt: unknown;
  readonly jobsInHand: unknown;
  readonly startedAt: unknown;
}

/**
 * Settles every promise already queued, several times over.
 *
 * @returns When the queue is drained.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await Promise.resolve();
  }
}

describe('WorkerHeartbeatService', () => {
  let query: jest.Mock<(sql: string, parameters?: unknown[]) => Promise<void>>;
  let current: jest.Mock<() => EngineHealth>;
  let listeners: EngineHealthListener[];
  let paused: boolean;
  let jobs: number;
  let activity: WorkerActivity;
  let service: WorkerHeartbeatService;

  /**
   * Reads back the upserts written so far.
   *
   * @returns Each upsert's parameters, in order.
   */
  function beats(): Beat[] {
    return query.mock.calls
      .filter(([sql]) => sql === HEARTBEAT_UPSERT)
      .map(([, parameters]) => {
        const [
          workerId,
          state,
          pauseReason,
          definitionsVersion,
          definitionsBuiltAt,
          jobsInHand,
          startedAt,
        ] = parameters as unknown[];

        return {
          workerId,
          state,
          pauseReason,
          definitionsVersion,
          definitionsBuiltAt,
          jobsInHand,
          startedAt,
        };
      });
  }

  beforeEach(() => {
    query = jest.fn(() => Promise.resolve());
    current = jest.fn(() => FIT);
    listeners = [];
    paused = false;
    jobs = 0;
    activity = {
      isPaused: (): boolean => paused,
      jobsInHand: (): number => jobs,
    };

    service = new WorkerHeartbeatService(
      { query } as unknown as DataSource,
      {
        current,
        onChange: (listener: EngineHealthListener) => listeners.push(listener),
      } as unknown as EngineHealthService,
      SETTINGS,
    );

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await service.beforeApplicationShutdown();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('the row it writes', () => {
    it('says a consuming worker is running, with its signatures and jobs', async () => {
      jobs = 2;

      service.start(activity);
      await settle();

      expect(beats()).toEqual([
        {
          workerId: service.workerId,
          state: 'RUNNING',
          pauseReason: null,
          definitionsVersion: '27412',
          definitionsBuiltAt: BUILT_AT,
          jobsInHand: 2,
          startedAt: expect.any(Date),
        },
      ]);
    });

    it('says a paused worker is paused, and why, as a code', async () => {
      paused = true;
      current.mockReturnValue(UNREACHABLE);

      service.start(activity);
      await settle();

      expect(beats()[0]).toEqual(
        expect.objectContaining({
          state: 'PAUSED',
          pauseReason: 'SCANNER_UNREACHABLE',
          definitionsVersion: null,
          definitionsBuiltAt: null,
        }),
      );
    });

    it('gives no reason for a worker paused while its scanner is fit', async () => {
      // A resume that Redis refused leaves the worker paused behind a fit
      // scanner. The row says paused, which is true, and claims no reason.
      paused = true;

      service.start(activity);
      await settle();

      expect(beats()[0]).toEqual(
        expect.objectContaining({ state: 'PAUSED', pauseReason: null }),
      );
    });

    it('removes the rows of processes gone for a day, on every beat', async () => {
      service.start(activity);
      await settle();

      expect(query).toHaveBeenLastCalledWith(HEARTBEAT_PRUNE);
    });

    it('keeps the same identity and start time from beat to beat', async () => {
      service.start(activity);
      await settle();
      await service.beat();

      const [first, second] = beats();

      expect(second.workerId).toBe(first.workerId);
      expect(second.startedAt).toBe(first.startedAt);
    });

    it('says when the first row is written, and only then', async () => {
      const log = jest.spyOn(Logger.prototype, 'log');

      service.start(activity);
      await settle();
      await service.beat();

      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining(`WorkerId: ${service.workerId}`),
      );
    });
  });

  describe('when it beats', () => {
    it('beats every interval', async () => {
      jest.useFakeTimers();

      service.start(activity);
      await jest.advanceTimersByTimeAsync(SETTINGS.workerHeartbeatIntervalMs);

      expect(beats()).toHaveLength(2);
    });

    it('beats as soon as the scanner changes', async () => {
      service.start(activity);
      await settle();

      paused = true;
      current.mockReturnValue(UNREACHABLE);
      listeners.forEach(listener => listener(UNREACHABLE));
      await settle();

      expect(beats().map(beat => beat.state)).toEqual(['RUNNING', 'PAUSED']);
    });

    it('ignores a second start', async () => {
      jest.useFakeTimers();

      service.start(activity);
      service.start(activity);
      await jest.advanceTimersByTimeAsync(SETTINGS.workerHeartbeatIntervalMs);

      expect(listeners).toHaveLength(1);
      expect(beats()).toHaveLength(2);
    });

    it('writes a beat asked for mid-write straight afterwards, and only once', async () => {
      let release: () => void = () => undefined;
      query.mockImplementationOnce(
        () =>
          new Promise<void>(resolve => {
            release = resolve;
          }),
      );

      service.start(activity);
      paused = true;
      const second = service.beat();
      const third = service.beat();
      release();
      await Promise.all([second, third]);

      expect(beats().map(beat => beat.state)).toEqual(['RUNNING', 'PAUSED']);
    });
  });

  describe('a beat that fails', () => {
    it.each([
      ['an error', new Error('connection terminated')],
      ['something that is not an error', 'connection terminated'],
    ])(
      'is logged and not thrown when the database throws %s',
      async (_label, thrown) => {
        const error = jest.spyOn(Logger.prototype, 'error');
        query.mockImplementationOnce(() => Promise.reject(thrown));

        service.start(activity);
        await settle();

        expect(error).toHaveBeenCalledWith(
          expect.stringContaining('Heartbeat not recorded'),
        );
      },
    );

    it('is tried again at the next beat', async () => {
      jest.useFakeTimers();
      query.mockImplementationOnce(() => Promise.reject(new Error('down')));

      service.start(activity);
      await jest.advanceTimersByTimeAsync(SETTINGS.workerHeartbeatIntervalMs);

      expect(beats()).toHaveLength(2);
      expect(query).toHaveBeenLastCalledWith(HEARTBEAT_PRUNE);
    });

    it('survives a consumer that cannot say what it is doing', async () => {
      const error = jest.spyOn(Logger.prototype, 'error');
      activity.isPaused = (): boolean => {
        throw new TypeError('no worker');
      };

      service.start(activity);
      await settle();

      expect(beats()).toHaveLength(0);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('no worker'));
    });
  });

  describe('on the way out', () => {
    it('says it is stopping, and stops beating', async () => {
      jest.useFakeTimers();
      paused = true;
      current.mockReturnValue(UNREACHABLE);
      service.start(activity);
      await jest.advanceTimersByTimeAsync(0);

      await service.beforeApplicationShutdown();
      await jest.advanceTimersByTimeAsync(
        SETTINGS.workerHeartbeatIntervalMs * 3,
      );

      expect(beats().map(beat => [beat.state, beat.pauseReason])).toEqual([
        ['PAUSED', 'SCANNER_UNREACHABLE'],
        ['STOPPING', null],
      ]);
    });

    it('writes nothing for a heartbeat that never started', async () => {
      await service.beforeApplicationShutdown();

      expect(query).not.toHaveBeenCalled();
    });
  });
});

describe('workerIdentifier', () => {
  it('names the host and process, and differs between two calls', () => {
    const first = workerIdentifier();

    expect(
      first.startsWith(`${hostname().slice(0, 200)}:${process.pid}:`),
    ).toBe(true);
    expect(workerIdentifier()).not.toBe(first);
  });

  it('always fits the column', () => {
    expect(workerIdentifier().length).toBeLessThanOrEqual(255);
  });
});

describe('pauseReasonCode', () => {
  it.each(Object.entries(ENGINE_UNFIT_REASONS))(
    'reports %s by its code',
    (code, reason) => {
      expect(pauseReasonCode({ ...UNREACHABLE, reason })).toBe(code);
    },
  );

  it('has no code for a fit scanner', () => {
    expect(pauseReasonCode(FIT)).toBeNull();
  });

  it('reports a reason it has no code for as unknown, never as the sentence', () => {
    expect(pauseReasonCode({ ...UNREACHABLE, reason: 'Something new' })).toBe(
      UNKNOWN_PAUSE_REASON,
    );
  });

  it('gives every code a shape the table accepts', () => {
    for (const code of [
      ...Object.keys(ENGINE_UNFIT_REASONS),
      UNKNOWN_PAUSE_REASON,
    ]) {
      expect(code).toMatch(/^[A-Z][A-Z_]{0,63}$/);
    }
  });
});
