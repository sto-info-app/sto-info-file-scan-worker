import { Logger } from '@nestjs/common';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

import { WorkerSettings } from '../../config/worker-settings';
import {
  RECOVERY_BATCH,
  ScanVerdictPublisherService,
} from './scan-verdict-publisher.service';
import {
  MAX_RECOVERY_PASSES,
  StrandedVerdictSweepService,
} from './stranded-verdict-sweep.service';

const SETTINGS = {
  strandedVerdictResendIntervalMs: 600_000,
} as WorkerSettings;

describe('StrandedVerdictSweepService', () => {
  let resend: jest.Mock<() => Promise<number>>;
  let service: StrandedVerdictSweepService;

  beforeEach(() => {
    resend = jest.fn(() => Promise.resolve(0));

    service = new StrandedVerdictSweepService(
      {
        resendStrandedVerdicts: resend,
      } as unknown as ScanVerdictPublisherService,
      SETTINGS,
    );

    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('when it sweeps', () => {
    it('sweeps once as the worker starts', () => {
      service.onApplicationBootstrap();

      expect(resend).toHaveBeenCalledTimes(1);
    });

    it('sweeps again every interval', async () => {
      jest.useFakeTimers();

      service.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(
        SETTINGS.strandedVerdictResendIntervalMs * 2,
      );

      expect(resend).toHaveBeenCalledTimes(3);
    });

    it('stops sweeping when the module is destroyed', async () => {
      jest.useFakeTimers();

      service.onApplicationBootstrap();
      service.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(
        SETTINGS.strandedVerdictResendIntervalMs * 3,
      );

      expect(resend).toHaveBeenCalledTimes(1);
    });

    it('can be destroyed before it ever started', () => {
      expect(() => service.onModuleDestroy()).not.toThrow();
    });

    it('shares one sweep between calls that overlap', async () => {
      let release: (count: number) => void = () => undefined;
      resend.mockImplementationOnce(
        () =>
          new Promise<number>(resolve => {
            release = resolve;
          }),
      );

      const first = service.sweep();
      const second = service.sweep();
      release(3);

      await expect(Promise.all([first, second])).resolves.toEqual([3, 3]);
      expect(resend).toHaveBeenCalledTimes(1);
    });
  });

  describe('how much it resends', () => {
    it('stops after a pass that came back short', async () => {
      resend.mockResolvedValueOnce(7);

      await expect(service.sweep()).resolves.toBe(7);
      expect(resend).toHaveBeenCalledTimes(1);
    });

    it('keeps going while each pass comes back full', async () => {
      // A long Redis outage strands more than one batch, and waiting ten
      // minutes for each further hundred would leave uploads hanging.
      resend
        .mockResolvedValueOnce(RECOVERY_BATCH)
        .mockResolvedValueOnce(RECOVERY_BATCH)
        .mockResolvedValueOnce(4);

      await expect(service.sweep()).resolves.toBe(RECOVERY_BATCH * 2 + 4);
      expect(resend).toHaveBeenCalledTimes(3);
    });

    it('gives up for this sweep after the most passes it makes', async () => {
      resend.mockResolvedValue(RECOVERY_BATCH);

      await expect(service.sweep()).resolves.toBe(
        RECOVERY_BATCH * MAX_RECOVERY_PASSES,
      );
      expect(resend).toHaveBeenCalledTimes(MAX_RECOVERY_PASSES);
    });
  });

  describe('a sweep that fails', () => {
    it.each([
      ['an error', new Error('Connection is closed.')],
      ['something that is not an error', 'Connection is closed.'],
    ])(
      'is logged, not thrown, when resending throws %s',
      async (_label, thrown) => {
        const error = jest.spyOn(Logger.prototype, 'error');
        resend
          .mockResolvedValueOnce(RECOVERY_BATCH)
          .mockImplementationOnce(() => Promise.reject(thrown));

        await expect(service.sweep()).resolves.toBe(RECOVERY_BATCH);
        expect(error).toHaveBeenCalledWith(
          expect.stringContaining(`Resent: ${RECOVERY_BATCH}`),
        );
      },
    );

    it('is tried again at the next interval', async () => {
      jest.useFakeTimers();
      resend.mockImplementationOnce(() => Promise.reject(new Error('down')));

      service.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(
        SETTINGS.strandedVerdictResendIntervalMs,
      );

      expect(resend).toHaveBeenCalledTimes(2);
    });
  });
});
