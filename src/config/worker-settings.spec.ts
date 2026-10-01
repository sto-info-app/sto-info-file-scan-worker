import { describe, expect, it } from '@jest/globals';

import {
  readWorkerSettings,
  WORKER_DATABASE_SCHEMA,
  WorkerSettingsError,
} from './worker-settings';

/**
 * Builds an environment that works, with changes applied.
 *
 * @param changes - Variables to override. An explicit undefined removes one.
 * @returns The environment.
 */
function environment(
  changes: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const base: Record<string, string> = {
    DB_SCHEMA: WORKER_DATABASE_SCHEMA,
    CLOUDFLARE_R2_QUARANTINE_BUCKET_NAME: 'sto-info-quarantine',
    CLOUDFLARE_R2_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
    AWS_SECRET_NAME: 'sto-info/worker',
  };

  const merged: NodeJS.ProcessEnv = { ...base };

  for (const [name, value] of Object.entries(changes)) {
    if (value === undefined) {
      delete merged[name];
    } else {
      merged[name] = value;
    }
  }

  return merged;
}

describe('readWorkerSettings', () => {
  describe('the settings it produces', () => {
    it('fills in every default', () => {
      expect(readWorkerSettings(environment())).toEqual({
        schemaVersion: 2,
        databaseSchema: WORKER_DATABASE_SCHEMA,
        quarantineBucket: 'sto-info-quarantine',
        quarantineEndpoint: 'https://account.r2.cloudflarestorage.com',
        awsSecretName: 'sto-info/worker',
        concurrency: 1,
        maxObjectBytes: 10 * 1024 * 1024,
        scanTimeoutMs: 120_000,
        leaseMs: 300_000,
        heartbeatMs: 30_000,
        maxAttempts: 3,
        maxDefinitionAgeMs: 48 * 60 * 60 * 1000,
        healthPollMs: 30_000,
        unhealthyRetryMs: 60_000,
        workerHeartbeatIntervalMs: 30_000,
        strandedVerdictResendIntervalMs: 600_000,
        clamdHost: '127.0.0.1',
        clamdPort: 3310,
      });
    });

    it('trims the values it is given', () => {
      const settings = readWorkerSettings(
        environment({ CLOUDFLARE_R2_QUARANTINE_BUCKET_NAME: '  bucket  ' }),
      );

      expect(settings.quarantineBucket).toBe('bucket');
    });

    it('takes the numbers it is given', () => {
      const settings = readWorkerSettings(
        environment({
          SCAN_CONCURRENCY: '4',
          MAX_FILE_BYTES: '2048',
          SCAN_TIMEOUT_MS: '30000',
          SCAN_LEASE_MS: '60000',
          SCAN_HEARTBEAT_MS: '5000',
          SCAN_MAX_ATTEMPTS: '7',
          CLAMAV_MAX_DEFINITION_AGE_HOURS: '12',
          CLAMAV_HEALTH_POLL_MS: '15000',
          SCAN_UNHEALTHY_RETRY_MS: '120000',
          WORKER_HEARTBEAT_INTERVAL_MS: '10000',
          STRANDED_VERDICT_RESEND_INTERVAL_MS: '300000',
          CLAMAV_HOST: 'clamd.internal',
          CLAMAV_PORT: '3311',
        }),
      );

      expect(settings).toEqual(
        expect.objectContaining({
          concurrency: 4,
          maxObjectBytes: 2048,
          scanTimeoutMs: 30_000,
          leaseMs: 60_000,
          heartbeatMs: 5_000,
          maxAttempts: 7,
          maxDefinitionAgeMs: 12 * 60 * 60 * 1000,
          healthPollMs: 15_000,
          unhealthyRetryMs: 120_000,
          workerHeartbeatIntervalMs: 10_000,
          strandedVerdictResendIntervalMs: 300_000,
          clamdHost: 'clamd.internal',
          clamdPort: 3311,
        }),
      );
    });

    it('treats a blank number as absent', () => {
      expect(
        readWorkerSettings(environment({ SCAN_MAX_ATTEMPTS: '  ' }))
          .maxAttempts,
      ).toBe(3);
    });

    it('falls back to the loopback address for a blank scanner host', () => {
      expect(
        readWorkerSettings(environment({ CLAMAV_HOST: '   ' })).clamdHost,
      ).toBe('127.0.0.1');
    });
  });

  describe('refusing to start', () => {
    it('refuses synchronise outright', () => {
      // Not merely defaulted off. The worker shares a database with the
      // backend, and synchronise would drop the backend's columns to make
      // the schema match these entities.
      expect(() =>
        readWorkerSettings(environment({ TYPEORM_SYNCHRONIZE: 'TRUE' })),
      ).toThrow('TYPEORM_SYNCHRONIZE must be false');
    });

    it('accepts synchronise set to false', () => {
      expect(() =>
        readWorkerSettings(environment({ TYPEORM_SYNCHRONIZE: 'false' })),
      ).not.toThrow();
    });

    it('refuses a schema the migrations do not write', () => {
      let caught: WorkerSettingsError | undefined;

      try {
        readWorkerSettings(environment({ DB_SCHEMA: 'sto_info_app' }));
      } catch (error) {
        caught = error as WorkerSettingsError;
      }

      expect(caught?.variable).toBe('DB_SCHEMA');
    });

    it.each([
      ['DB_SCHEMA'],
      ['CLOUDFLARE_R2_QUARANTINE_BUCKET_NAME'],
      ['CLOUDFLARE_R2_ENDPOINT'],
      ['AWS_SECRET_NAME'],
    ])('refuses a missing %s', variable => {
      let caught: WorkerSettingsError | undefined;

      try {
        readWorkerSettings(environment({ [variable]: undefined }));
      } catch (error) {
        caught = error as WorkerSettingsError;
      }

      expect(caught?.variable).toBe(variable);
    });

    it('refuses a blank required value', () => {
      expect(() =>
        readWorkerSettings(environment({ AWS_SECRET_NAME: '   ' })),
      ).toThrow('AWS_SECRET_NAME must be set');
    });

    it('refuses a contract version the build does not support', () => {
      // ADR-0006 decision 3. Refused here, at startup, rather than one
      // message at a time with files already queued.
      expect(() =>
        readWorkerSettings(environment({ FILE_SCAN_SCHEMA_VERSION: '1' })),
      ).toThrow('does not support: 1');
    });

    it.each([
      ['below the floor', { SCAN_LEASE_MS: '5000' }, 'SCAN_LEASE_MS'],
      ['above the ceiling', { SCAN_CONCURRENCY: '64' }, 'SCAN_CONCURRENCY'],
      ['not a number', { SCAN_MAX_ATTEMPTS: 'three' }, 'SCAN_MAX_ATTEMPTS'],
      ['fractional', { CLAMAV_PORT: '3310.5' }, 'CLAMAV_PORT'],
      [
        'polling faster than a second',
        { CLAMAV_HEALTH_POLL_MS: '999' },
        'CLAMAV_HEALTH_POLL_MS',
      ],
      [
        'deferring a job for longer than an hour',
        { SCAN_UNHEALTHY_RETRY_MS: '3600001' },
        'SCAN_UNHEALTHY_RETRY_MS',
      ],
      [
        // The backend calls a worker silent after two minutes, so a slower
        // beat would raise the alert on a worker that is fine.
        'beating less than once a minute',
        { WORKER_HEARTBEAT_INTERVAL_MS: '60001' },
        'WORKER_HEARTBEAT_INTERVAL_MS',
      ],
      [
        'resending stranded verdicts more than once a minute',
        { STRANDED_VERDICT_RESEND_INTERVAL_MS: '59999' },
        'STRANDED_VERDICT_RESEND_INTERVAL_MS',
      ],
    ])('refuses a value %s', (_description, changes, variable) => {
      let caught: WorkerSettingsError | undefined;

      try {
        readWorkerSettings(environment(changes));
      } catch (error) {
        caught = error as WorkerSettingsError;
      }

      expect(caught?.variable).toBe(variable);
    });

    it('refuses a heartbeat that outlasts the lease it renews', () => {
      // A heartbeat slower than the lease renews nothing: the lease has
      // already lapsed by the time it fires, and every long scan would be
      // taken from under the worker doing it.
      expect(() =>
        readWorkerSettings(
          environment({ SCAN_LEASE_MS: '30000', SCAN_HEARTBEAT_MS: '30000' }),
        ),
      ).toThrow('must be shorter than SCAN_LEASE_MS');
    });

    it('refuses a scan that may outlast its own claim', () => {
      expect(() =>
        readWorkerSettings(
          environment({
            SCAN_LEASE_MS: '60000',
            SCAN_HEARTBEAT_MS: '5000',
            SCAN_TIMEOUT_MS: '60000',
          }),
        ),
      ).toThrow('SCAN_TIMEOUT_MS must be shorter than SCAN_LEASE_MS');
    });
  });

  describe('the error it raises', () => {
    it('names the variable and not its value', () => {
      const error = new WorkerSettingsError('DB_SCHEMA', 'must be set');

      expect(error.name).toBe('WorkerSettingsError');
      expect(error.variable).toBe('DB_SCHEMA');
      expect(error.message).toBe('DB_SCHEMA must be set');
    });
  });
});
