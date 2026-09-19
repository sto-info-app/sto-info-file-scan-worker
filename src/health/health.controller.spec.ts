import { ServiceUnavailableException } from '@nestjs/common';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { WorkerSettings } from '../config/worker-settings';
import {
  ScanEngine,
  ScanEngineDescription,
} from '../scanning/scan-engine.interface';
import { HealthController } from './health.controller';

const SETTINGS = {
  schemaVersion: 1,
  maxDefinitionAgeMs: 48 * 60 * 60 * 1000,
} as WorkerSettings;

const FRESH: ScanEngineDescription = {
  engine: 'clamav',
  engineVersion: '1.4.2',
  signatureVersion: '27412',
  definitionEpoch: '27412',
  definitionsBuiltAt: new Date(Date.now() - 60_000),
};

describe('HealthController', () => {
  let describeEngine: jest.Mock;
  let controller: HealthController;

  beforeEach(() => {
    describeEngine = jest.fn(() => Promise.resolve(FRESH));

    controller = new HealthController(
      { describe: describeEngine } as unknown as ScanEngine,
      SETTINGS,
    );
  });

  describe('liveness', () => {
    it('answers without asking the scanner anything', () => {
      // Two probes, two questions. Liveness must answer even when the
      // scanner is down, or an orchestrator would restart a process whose
      // only problem is that clamd has not finished loading.
      expect(controller.getHealth()).toEqual({ ok: true, schemaVersion: 1 });
      expect(describeEngine).not.toHaveBeenCalled();
    });
  });

  describe('readiness', () => {
    it('reports the scanner it found', async () => {
      await expect(controller.getReadiness()).resolves.toEqual({
        ok: true,
        schemaVersion: 1,
        engine: 'clamav',
        engineVersion: '1.4.2',
        signatureVersion: '27412',
      });
    });

    it('fails while the scanner cannot be reached', async () => {
      describeEngine.mockImplementationOnce(() =>
        Promise.reject(new Error('ECONNREFUSED')),
      );

      await expect(controller.getReadiness()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('fails while no signature database is loaded', async () => {
      // ADR-0005 put this among FC-003's criteria. Silence about the age of
      // the signatures is not evidence that they are young.
      describeEngine.mockImplementationOnce(() =>
        Promise.resolve({ ...FRESH, definitionsBuiltAt: null }),
      );

      await expect(controller.getReadiness()).rejects.toThrow(
        'did not say how old its signatures are',
      );
    });

    it('fails while the signatures are older than the policy allows', async () => {
      describeEngine.mockImplementationOnce(() =>
        Promise.resolve({
          ...FRESH,
          definitionsBuiltAt: new Date(Date.now() - 72 * 60 * 60 * 1000),
        }),
      );

      await expect(controller.getReadiness()).rejects.toThrow(
        'older than the policy allows',
      );
    });

    it('accepts signatures right on the limit', async () => {
      // The clock is frozen so that the two readings of it — the one that
      // builds the fixture and the one inside the probe — are the same
      // instant. Without that this asserts nothing about the boundary,
      // only about how long the assignment above took.
      jest.useFakeTimers({ now: new Date('2026-09-19T12:00:00.000Z') });

      try {
        describeEngine.mockImplementationOnce(() =>
          Promise.resolve({
            ...FRESH,
            definitionsBuiltAt: new Date(
              Date.now() - SETTINGS.maxDefinitionAgeMs,
            ),
          }),
        );

        await expect(controller.getReadiness()).resolves.toEqual(
          expect.objectContaining({ ok: true }),
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('refuses signatures one millisecond past it', async () => {
      jest.useFakeTimers({ now: new Date('2026-09-19T12:00:00.000Z') });

      try {
        describeEngine.mockImplementationOnce(() =>
          Promise.resolve({
            ...FRESH,
            definitionsBuiltAt: new Date(
              Date.now() - SETTINGS.maxDefinitionAgeMs - 1,
            ),
          }),
        );

        await expect(controller.getReadiness()).rejects.toThrow(
          'older than the policy allows',
        );
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
