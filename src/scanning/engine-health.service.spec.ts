import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

import { WorkerSettings } from '../config/worker-settings';
import { EngineHealth, EngineHealthService } from './engine-health.service';
import { ScanEngine, ScanEngineDescription } from './scan-engine.interface';

const MAX_DEFINITION_AGE_MS = 48 * 60 * 60 * 1000;

const SETTINGS = {
  maxDefinitionAgeMs: MAX_DEFINITION_AGE_MS,
  healthPollMs: 30_000,
} as WorkerSettings;

/**
 * Builds a description of a scanner.
 *
 * @param changes - Fields to override.
 * @returns The description.
 */
function description(
  changes: Partial<ScanEngineDescription> = {},
): ScanEngineDescription {
  return {
    engine: 'clamav',
    engineVersion: '1.4.2',
    signatureVersion: '27412',
    definitionEpoch: '27412',
    definitionsBuiltAt: new Date(Date.now() - 60_000),
    ...changes,
  };
}

describe('EngineHealthService', () => {
  let describeEngine: jest.Mock<() => Promise<ScanEngineDescription>>;
  let service: EngineHealthService;

  beforeEach(() => {
    describeEngine = jest.fn(() => Promise.resolve(description()));

    service = new EngineHealthService(
      { describe: describeEngine } as unknown as ScanEngine,
      SETTINGS,
    );
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
  });

  describe('before it has asked', () => {
    it('reports the scanner as unfit', () => {
      // The starting state matters more than it looks: a worker that
      // treated "not asked yet" as fit would consume its first job in the
      // moment between construction and the first answer.
      expect(service.current()).toEqual(
        expect.objectContaining({
          healthy: false,
          reason: 'The scanner has not been asked yet',
          description: null,
        }),
      );
    });
  });

  describe('asking', () => {
    it('reports a scanner with fresh signatures as fit', async () => {
      await service.check();

      expect(service.current()).toEqual(
        expect.objectContaining({ healthy: true, reason: null }),
      );
      expect(service.current().description).toEqual(
        expect.objectContaining({ engine: 'clamav' }),
      );
    });

    it('reports a scanner that cannot be reached as unfit', async () => {
      describeEngine.mockImplementation(() =>
        Promise.reject(new Error('ECONNREFUSED')),
      );

      await service.check();

      expect(service.current()).toEqual(
        expect.objectContaining({
          healthy: false,
          reason: 'The scanner cannot be reached',
          description: null,
        }),
      );
    });

    it('reports a scanner that will not date its signatures as unfit', async () => {
      // ADR-0005 decision 4. Silence about the age of the signatures is not
      // evidence that they are young.
      describeEngine.mockImplementation(() =>
        Promise.resolve(description({ definitionsBuiltAt: null })),
      );

      await service.check();

      expect(service.current().reason).toBe(
        'The scanner did not say how old its signatures are',
      );
    });

    it('keeps no description of a scanner that stopped answering', async () => {
      // The last good answer is not evidence about the scanner running now,
      // and an attempt records which signatures judged it.
      await service.check();
      describeEngine.mockImplementation(() =>
        Promise.reject(new Error('ECONNREFUSED')),
      );
      await service.check();

      expect(service.current().description).toBeNull();
    });

    it('accepts signatures right on the age limit', () => {
      jest.useFakeTimers({ now: new Date('2026-09-20T12:00:00.000Z') });

      describeEngine.mockImplementation(() =>
        Promise.resolve(
          description({
            definitionsBuiltAt: new Date(Date.now() - MAX_DEFINITION_AGE_MS),
          }),
        ),
      );

      return service.check().then(health => {
        expect(health.healthy).toBe(true);
      });
    });

    it('refuses signatures one millisecond past it', () => {
      jest.useFakeTimers({ now: new Date('2026-09-20T12:00:00.000Z') });

      describeEngine.mockImplementation(() =>
        Promise.resolve(
          description({
            definitionsBuiltAt: new Date(
              Date.now() - MAX_DEFINITION_AGE_MS - 1,
            ),
          }),
        ),
      );

      return service.check().then(health => {
        expect(health).toEqual(
          expect.objectContaining({
            healthy: false,
            reason: 'The signature database is older than the policy allows',
          }),
        );
      });
    });

    it('shares one conversation between overlapping checks', async () => {
      // A describe that outlasts the poll interval would otherwise have a
      // second one started beside it, and two answers racing to be stored
      // is worse than a late answer.
      let release: (value: ScanEngineDescription) => void = () => undefined;

      describeEngine.mockImplementation(
        () =>
          new Promise<ScanEngineDescription>(resolve => {
            release = resolve;
          }),
      );

      const first = service.check();
      const second = service.check();

      release(description());
      await Promise.all([first, second]);

      expect(describeEngine).toHaveBeenCalledTimes(1);
    });

    it('asks again once the last conversation has finished', async () => {
      await service.check();
      await service.check();

      expect(describeEngine).toHaveBeenCalledTimes(2);
    });
  });

  describe('telling other things', () => {
    it('announces the change from unfit to fit', async () => {
      const heard: EngineHealth[] = [];
      service.onChange(health => heard.push(health));

      await service.check();

      expect(heard).toHaveLength(1);
      expect(heard[0].healthy).toBe(true);
    });

    it('says nothing when the answer has not changed', async () => {
      await service.check();

      const heard: EngineHealth[] = [];
      service.onChange(health => heard.push(health));

      await service.check();

      expect(heard).toHaveLength(0);
    });

    it('announces the change back to unfit', async () => {
      await service.check();

      const heard: EngineHealth[] = [];
      service.onChange(health => heard.push(health));

      describeEngine.mockImplementation(() =>
        Promise.reject(new Error('ECONNREFUSED')),
      );
      await service.check();

      expect(heard).toHaveLength(1);
      expect(heard[0]).toEqual(
        expect.objectContaining({
          healthy: false,
          reason: 'The scanner cannot be reached',
        }),
      );
    });
  });

  describe('its timer', () => {
    it('asks once before it starts polling', async () => {
      jest.useFakeTimers();

      await service.onModuleInit();

      expect(describeEngine).toHaveBeenCalledTimes(1);
    });

    it('keeps asking on the interval', async () => {
      jest.useFakeTimers();

      await service.onModuleInit();

      // One tick at a time, each awaited. Advancing three intervals in one
      // step would prove the opposite of what it looks like: the first
      // answer would still be in flight, and the other two ticks would join
      // it rather than ask again.
      for (let tick = 0; tick < 3; tick += 1) {
        await jest.advanceTimersByTimeAsync(SETTINGS.healthPollMs);
      }

      expect(describeEngine).toHaveBeenCalledTimes(4);
    });

    it('starts even when the scanner is not there yet', async () => {
      // A container whose clamd is still loading is starting normally. The
      // right response is a worker that scans nothing, not a process that
      // refuses to run.
      jest.useFakeTimers();
      describeEngine.mockImplementation(() =>
        Promise.reject(new Error('ECONNREFUSED')),
      );

      await expect(service.onModuleInit()).resolves.toBeUndefined();
      expect(service.current().healthy).toBe(false);
    });

    it('stops asking when the module goes down', async () => {
      jest.useFakeTimers();

      await service.onModuleInit();
      service.onModuleDestroy();
      jest.advanceTimersByTime(SETTINGS.healthPollMs * 3);

      expect(describeEngine).toHaveBeenCalledTimes(1);
    });

    it('is safe to shut down twice', async () => {
      jest.useFakeTimers();

      await service.onModuleInit();
      service.onModuleDestroy();

      expect(() => service.onModuleDestroy()).not.toThrow();
    });
  });
});
