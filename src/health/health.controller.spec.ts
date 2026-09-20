import { ServiceUnavailableException } from '@nestjs/common';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { WorkerSettings } from '../config/worker-settings';
import {
  EngineHealth,
  EngineHealthService,
} from '../scanning/engine-health.service';
import { ScanEngineDescription } from '../scanning/scan-engine.interface';
import { HealthController } from './health.controller';

const SETTINGS = { schemaVersion: 2 } as WorkerSettings;

const CHECKED_AT = new Date('2026-09-20T09:00:00.000Z');

const DESCRIPTION: ScanEngineDescription = {
  engine: 'clamav',
  engineVersion: '1.4.2',
  signatureVersion: '27412',
  definitionEpoch: '27412',
  definitionsBuiltAt: new Date('2026-09-20T08:00:00.000Z'),
};

const FIT: EngineHealth = {
  healthy: true,
  reason: null,
  description: DESCRIPTION,
  checkedAt: CHECKED_AT,
};

describe('HealthController', () => {
  let current: jest.Mock<() => EngineHealth>;
  let controller: HealthController;

  beforeEach(() => {
    current = jest.fn(() => FIT);

    controller = new HealthController(
      { current } as unknown as EngineHealthService,
      SETTINGS,
    );
  });

  describe('liveness', () => {
    it('answers without asking about the scanner at all', () => {
      // Two probes, two questions. Liveness must answer even when the
      // scanner is down, or an orchestrator would restart a process whose
      // only problem is that clamd has not finished loading.
      expect(controller.getHealth()).toEqual({ ok: true, schemaVersion: 2 });
      expect(current).not.toHaveBeenCalled();
    });
  });

  describe('readiness', () => {
    it('reports the scanner the health poll found', () => {
      expect(controller.getReadiness()).toEqual({
        ok: true,
        schemaVersion: 2,
        engine: 'clamav',
        engineVersion: '1.4.2',
        signatureVersion: '27412',
        checkedAt: '2026-09-20T09:00:00.000Z',
      });
    });

    it('never opens a connection of its own', () => {
      // The probe reads what the poll established rather than asking again.
      // Anything that can reach this port could otherwise make the worker
      // talk to clamd as often as it liked, and the answer it returned
      // might not be the one the pipeline was acting on.
      controller.getReadiness();

      expect(current).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['the scanner cannot be reached', 'The scanner cannot be reached'],
      [
        'no signature database is loaded',
        'The scanner did not say how old its signatures are',
      ],
      [
        'the signatures are older than the policy allows',
        'The signature database is older than the policy allows',
      ],
    ])('fails while %s', (_description, reason) => {
      current.mockReturnValue({
        healthy: false,
        reason,
        description: null,
        checkedAt: CHECKED_AT,
      });

      expect(() => controller.getReadiness()).toThrow(reason);
    });

    it('fails before the scanner has been asked even once', () => {
      current.mockReturnValue({
        healthy: false,
        reason: 'The scanner has not been asked yet',
        description: null,
        checkedAt: new Date(0),
      });

      expect(() => controller.getReadiness()).toThrow(
        ServiceUnavailableException,
      );
    });

    it('fails rather than report a fitness it cannot describe', () => {
      // Belt and braces: healthy with no description is a state the health
      // service does not produce, and reporting `engine: undefined` would
      // be worse than refusing.
      current.mockReturnValue({ ...FIT, description: null });

      expect(() => controller.getReadiness()).toThrow(
        'The scanner cannot be trusted',
      );
    });
  });
});
