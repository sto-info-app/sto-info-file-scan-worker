import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { DelayedError, Job } from 'bullmq';

import { WorkerSettings } from '../../config/worker-settings';
import { ScanVerdictMessage } from '../../contract/file-scan-contract';
import {
  EngineHealth,
  EngineHealthListener,
  EngineHealthService,
  EngineUnfitError,
} from '../../scanning/engine-health.service';
import { FileScanService } from '../services/file-scan.service';
import { ScanVerdictPublisherService } from '../services/scan-verdict-publisher.service';
import { FileScanProcessor } from './file-scan.processor';

const FIXTURE = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'contract',
      '__fixtures__',
      'file-scan-contract-v2.json',
    ),
    'utf8',
  ),
);

const VERDICT = FIXTURE.verdicts.clean as ScanVerdictMessage;

const SETTINGS = {
  schemaVersion: 2,
  unhealthyRetryMs: 60_000,
} as WorkerSettings;

const FIT: EngineHealth = {
  healthy: true,
  reason: null,
  description: null,
  checkedAt: new Date(),
};

const UNFIT: EngineHealth = {
  healthy: false,
  reason: 'The scanner cannot be reached',
  description: null,
  checkedAt: new Date(),
};

/**
 * Builds a stand-in for `Job.moveToDelayed`.
 *
 * @returns The mock, typed as the two arguments the processor passes it.
 */
function deferral(): jest.Mock<
  (timestamp: number, token?: string) => Promise<void>
> {
  // Cast rather than named-and-ignored parameters: the arguments matter to
  // `toHaveBeenCalledWith`, which needs the signature, and to nothing else.
  return jest.fn(() => Promise.resolve()) as unknown as jest.Mock<
    (timestamp: number, token?: string) => Promise<void>
  >;
}

/**
 * Builds a job carrying whatever body the test wants.
 *
 * @param data - The body.
 * @param moveToDelayed - What to record a deferral with.
 * @returns The job.
 */
function job(
  data: unknown,
  moveToDelayed: jest.Mock<
    (timestamp: number, token?: string) => Promise<void>
  > = deferral(),
): Job<unknown> {
  return { id: 'job-1', data, moveToDelayed } as unknown as Job<unknown>;
}

describe('FileScanProcessor', () => {
  let scan: jest.Mock;
  let publish: jest.Mock;
  let current: jest.Mock<() => EngineHealth>;
  let listeners: EngineHealthListener[];
  let pause: jest.Mock;
  let resume: jest.Mock;
  let paused: boolean;
  let processor: FileScanProcessor;

  /**
   * Gives the processor a BullMQ worker to pause and resume.
   *
   * `WorkerHost` reads it from a private field that only the Nest BullMQ
   * explorer writes, so a test has to put one there itself.
   *
   * @param target - The processor.
   */
  function attachWorker(target: FileScanProcessor): void {
    Object.defineProperty(target, 'worker', {
      configurable: true,
      value: {
        pause,
        resume,
        isPaused: (): boolean => paused,
      },
    });
  }

  beforeEach(() => {
    paused = false;
    listeners = [];

    pause = jest.fn(() => {
      paused = true;

      return Promise.resolve();
    });
    resume = jest.fn(() => {
      paused = false;

      return Promise.resolve();
    });

    scan = jest.fn(() => Promise.resolve(VERDICT));
    publish = jest.fn(() => Promise.resolve());
    current = jest.fn(() => FIT);

    processor = new FileScanProcessor(
      { scan } as unknown as FileScanService,
      { publish } as unknown as ScanVerdictPublisherService,
      {
        current,
        onChange: (listener: EngineHealthListener) => listeners.push(listener),
      } as unknown as EngineHealthService,
      SETTINGS,
    );

    attachWorker(processor);
  });

  describe('a well-formed request', () => {
    it('scans it and sends the answer on', async () => {
      await processor.process(job(FIXTURE.request));

      expect(scan).toHaveBeenCalledWith(FIXTURE.request);
      expect(publish).toHaveBeenCalledWith(VERDICT);
    });

    it('sends nothing when the pipeline had nothing to say', async () => {
      scan.mockImplementationOnce(() => Promise.resolve(null));

      await processor.process(job(FIXTURE.request));

      expect(publish).not.toHaveBeenCalled();
    });
  });

  describe('a message it will not act on', () => {
    it('drops one that violates the contract', async () => {
      // Dropped rather than retried. It will violate the contract
      // identically on every attempt, and the asset stays where the backend
      // left it, which is not serveable.
      await processor.process(job({ schemaVersion: 2, assetId: 'nope' }));

      expect(scan).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    });

    it('drops one written against a version this process does not speak', async () => {
      processor = new FileScanProcessor(
        { scan } as unknown as FileScanService,
        { publish } as unknown as ScanVerdictPublisherService,
        {
          current,
          onChange: () => undefined,
        } as unknown as EngineHealthService,
        { ...SETTINGS, schemaVersion: 0 } as WorkerSettings,
      );
      attachWorker(processor);

      await processor.process(job(FIXTURE.request));

      expect(scan).not.toHaveBeenCalled();
    });
  });

  describe('a scanner that is not fit to judge', () => {
    it('defers the job instead of failing it', async () => {
      // Five failures during a freshclam outage would empty the queue into
      // the failed set for a fault that ends on its own — ADR-0020.
      const moveToDelayed = deferral();
      scan.mockImplementationOnce(() =>
        Promise.reject(new EngineUnfitError('The scanner cannot be reached')),
      );
      jest.spyOn(Date, 'now').mockReturnValue(1_000);

      try {
        await expect(
          processor.process(job(FIXTURE.request, moveToDelayed), 'token-1'),
        ).rejects.toBeInstanceOf(DelayedError);

        expect(moveToDelayed).toHaveBeenCalledWith(61_000, 'token-1');
      } finally {
        jest.restoreAllMocks();
      }
    });

    it('sends no verdict for a job it deferred', async () => {
      scan.mockImplementationOnce(() =>
        Promise.reject(new EngineUnfitError('The scanner cannot be reached')),
      );

      await expect(
        processor.process(job(FIXTURE.request, deferral()), 'token-1'),
      ).rejects.toBeInstanceOf(DelayedError);

      expect(publish).not.toHaveBeenCalled();
    });
  });

  describe('matching the queue to the scanner', () => {
    it('starts paused when the scanner is not ready', () => {
      // A container whose clamd is still loading starts consuming nothing,
      // which is the correct way round.
      current.mockReturnValue(UNFIT);

      processor.onApplicationBootstrap();

      expect(pause).toHaveBeenCalled();
    });

    it('starts consuming when the scanner is already fit', () => {
      processor.onApplicationBootstrap();

      expect(pause).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
    });

    it('pauses when the scanner becomes unfit', async () => {
      processor.onApplicationBootstrap();

      await Promise.all(listeners.map(listener => listener(UNFIT)));

      expect(pause).toHaveBeenCalledTimes(1);
    });

    it('resumes when the scanner recovers', async () => {
      current.mockReturnValue(UNFIT);
      processor.onApplicationBootstrap();
      await Promise.resolve();

      await Promise.all(listeners.map(listener => listener(FIT)));

      expect(resume).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['an error', new Error('LOADING')],
      ['something that is not an error', 'LOADING'],
    ])(
      'survives a pause that Redis refuses with %s',
      async (_label, thrown) => {
        // Called from a health-poll listener with nobody awaiting it, so an
        // escaping rejection would end the process. A momentary Redis hiccup
        // is not worth a restart: the worker stays up and out of step, and
        // says so — whatever the client threw.
        current.mockReturnValue(UNFIT);
        pause.mockImplementation(() => Promise.reject(thrown));

        expect(() => processor.onApplicationBootstrap()).not.toThrow();

        await Promise.resolve();
        await Promise.resolve();

        expect(pause).toHaveBeenCalled();
      },
    );

    it('leaves an already paused queue alone', async () => {
      // A second unfit answer is not news. Pausing again on every health
      // check would fill the log with the same line during an outage that
      // is already visible from its first.
      paused = true;
      current.mockReturnValue(UNFIT);

      processor.onApplicationBootstrap();
      await Promise.all(listeners.map(listener => listener(UNFIT)));

      expect(pause).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
    });
  });

  describe('a failure it cannot answer', () => {
    it('lets a scan failure through so BullMQ keeps the job', async () => {
      // A job in the failed set is visible. A job swallowed by a catch is
      // not, and an asset left in SCANNING with nothing scanning it is the
      // one outcome nobody would notice.
      scan.mockImplementationOnce(() => Promise.reject(new Error('no clamd')));

      await expect(processor.process(job(FIXTURE.request))).rejects.toThrow(
        'no clamd',
      );
    });

    it('lets a parse failure that is not a contract violation through', async () => {
      const exploding = {
        get schemaVersion(): number {
          throw new TypeError('something unexpected');
        },
      };

      await expect(processor.process(job(exploding))).rejects.toThrow(
        'something unexpected',
      );
    });
  });
});
