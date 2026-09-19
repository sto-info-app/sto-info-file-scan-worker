import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { WorkerSettings } from '../../config/worker-settings';
import { ScanRequestMessage } from '../../contract/file-scan-contract';
import {
  QuarantineObjectMissingError,
  QuarantineObjectService,
} from '../../quarantine/quarantine-object.service';
import {
  ScanEngine,
  ScanEngineDescription,
  ScanEngineResult,
} from '../../scanning/scan-engine.interface';
import { FileScanAttemptEntity } from '../entities/file-scan-attempt.entity';
import { FileScanAttemptState } from '../enums/file-scan-attempt-state.enum';
import {
  AttemptCompletion,
  FileScanAttemptService,
} from './file-scan-attempt.service';
import { FileScanService } from './file-scan.service';

const SETTINGS = {
  maxObjectBytes: 1024,
  heartbeatMs: 30_000,
  maxDefinitionAgeMs: 48 * 60 * 60 * 1000,
} as WorkerSettings;

const CONTENT = Buffer.from('a sanitised roster export', 'utf8');
const CONTENT_SHA = createHash('sha256').update(CONTENT).digest('hex');
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  Buffer.alloc(16),
]);

const LEASE_TOKEN = 'e3b0c442-98fc-4c14-9afb-f4c8996fb924';
const ATTEMPT_ID = '7c9e1b2d-3a4f-4e5b-9c8d-1a2b3c4d5e6f';

/**
 * Builds a request for the fixture content.
 *
 * @param changes - Fields to override.
 * @returns The request.
 */
function request(
  changes: Partial<ScanRequestMessage> = {},
): ScanRequestMessage {
  return {
    schemaVersion: 1,
    assetId: '4f1a0e2c-8b3d-4a59-9c21-6f7e5d4c3b2a',
    objectKey: 'prod/assets/4f1a0e2c-8b3d-4a59-9c21-6f7e5d4c3b2a',
    objectVersion: null,
    expectedSha256: CONTENT_SHA,
    policyVersion: 1,
    campaignId: null,
    traceId: '0b5d4f6a-1c2e-4d3b-8a7f-9e8d7c6b5a40',
    ...changes,
  };
}

/**
 * Builds the attempt row a claim hands back.
 *
 * @param changes - Fields to override.
 * @returns The row.
 */
function attempt(
  changes: Partial<FileScanAttemptEntity> = {},
): FileScanAttemptEntity {
  return {
    id: ATTEMPT_ID,
    assetId: request().assetId,
    objectKey: request().objectKey,
    objectVersion: null,
    expectedSha256: CONTENT_SHA,
    observedSha256: null,
    byteSize: null,
    detectedContentType: null,
    policyVersion: 1,
    definitionEpoch: '27412',
    campaignId: null,
    traceId: request().traceId,
    state: FileScanAttemptState.CLAIMED,
    rejectionCode: null,
    failureReason: null,
    engine: 'clamav',
    engineVersion: '1.4.2',
    signatureVersion: '27412',
    attemptCount: 1,
    leaseToken: LEASE_TOKEN,
    leaseExpiresAt: new Date(),
    heartbeatAt: new Date(),
    startedAt: null,
    completedAt: new Date('2026-09-19T12:00:00.000Z'),
    verdictPublishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...changes,
  } as FileScanAttemptEntity;
}

describe('FileScanService', () => {
  let attempts: {
    claim: jest.Mock;
    markScanning: jest.Mock;
    heartbeat: jest.Mock;
    complete: jest.Mock;
  };
  let quarantine: { getStream: jest.Mock };
  let engine: { describe: jest.Mock; scan: jest.Mock };
  let service: FileScanService;
  let completion: AttemptCompletion | undefined;

  const description: ScanEngineDescription = {
    engine: 'clamav',
    engineVersion: '1.4.2',
    signatureVersion: '27412',
    definitionEpoch: '27412',
    definitionsBuiltAt: new Date(Date.now() - 60_000),
  };

  beforeEach(() => {
    completion = undefined;

    attempts = {
      claim: jest.fn(() =>
        Promise.resolve({ kind: 'CLAIMED', attempt: attempt() }),
      ),
      markScanning: jest.fn(() => Promise.resolve(true)),
      heartbeat: jest.fn(() => Promise.resolve(true)),
      complete: jest.fn((_id: unknown, _token: unknown, given: unknown) => {
        completion = given as AttemptCompletion;

        return Promise.resolve(
          attempt({
            state: completion.state,
            observedSha256: completion.observedSha256,
            rejectionCode: completion.rejectionCode,
          }),
        );
      }),
    };

    quarantine = {
      getStream: jest.fn(() => Promise.resolve(Readable.from([CONTENT]))),
    };

    engine = {
      describe: jest.fn(() => Promise.resolve(description)),
      scan: jest.fn(async (source: unknown) => {
        // A real engine consumes the stream, and so must this one: the hash
        // and the byte count only exist because the bytes went past.
        for await (const _chunk of source as Readable) {
          void _chunk;
        }

        return { outcome: 'CLEAN', detail: null } as ScanEngineResult;
      }),
    };

    service = new FileScanService(
      attempts as unknown as FileScanAttemptService,
      quarantine as unknown as QuarantineObjectService,
      engine as unknown as ScanEngine,
      SETTINGS,
    );
  });

  describe('a clean object', () => {
    it('finishes the attempt as clean', async () => {
      await service.scan(request());

      expect(completion).toEqual(
        expect.objectContaining({
          state: FileScanAttemptState.CLEAN,
          observedSha256: CONTENT_SHA,
          byteSize: CONTENT.length,
          rejectionCode: null,
        }),
      );
    });

    it('answers with a clean verdict carrying the trace it was given', async () => {
      const verdict = await service.scan(request());

      expect(verdict).toEqual(
        expect.objectContaining({
          outcome: 'CLEAN',
          assetId: request().assetId,
          attemptId: ATTEMPT_ID,
          observedSha256: CONTENT_SHA,
          traceId: request().traceId,
          scannedAt: '2026-09-19T12:00:00.000Z',
        }),
      );
    });

    it('records what the first bytes looked like', async () => {
      quarantine.getStream.mockImplementationOnce(() =>
        Promise.resolve(Readable.from([PNG])),
      );

      await service.scan(
        request({
          expectedSha256: createHash('sha256').update(PNG).digest('hex'),
        }),
      );

      expect(completion?.detectedContentType).toBe('image/png');
    });

    it('reads the object the message named and no other', async () => {
      await service.scan(request());

      expect(quarantine.getStream).toHaveBeenCalledWith(
        request().objectKey,
        null,
      );
    });

    it('asks the scanner what it is before it claims anything', async () => {
      // The signature database's identity is part of the idempotency key,
      // so it has to be known before a row can be written.
      await service.scan(request());

      expect(engine.describe.mock.invocationCallOrder[0]).toBeLessThan(
        attempts.claim.mock.invocationCallOrder[0],
      );
    });
  });

  describe('a scanner that says no', () => {
    it.each([
      ['a detection', 'INFECTED', 'INFECTED'],
      ['a payload it cannot open', 'UNSUPPORTED', 'UNSUPPORTED_PAYLOAD'],
    ])('refuses on %s', async (_description, outcome, rejectionCode) => {
      engine.scan.mockImplementationOnce(async (source: unknown) => {
        for await (const _chunk of source as Readable) {
          void _chunk;
        }

        return { outcome, detail: 'Eicar FOUND' } as ScanEngineResult;
      });

      const verdict = await service.scan(request());

      expect(completion?.state).toBe(FileScanAttemptState.REJECTED);
      expect(completion?.rejectionCode).toBe(rejectionCode);
      expect(verdict?.outcome).toBe('REJECTED');
    });

    it('keeps the signature name out of the verdict', async () => {
      // ADR-0005 decision 6. The name goes on the attempt row, which is
      // administrator-only, and nowhere a reader can reach.
      engine.scan.mockImplementationOnce(async (source: unknown) => {
        for await (const _chunk of source as Readable) {
          void _chunk;
        }

        return {
          outcome: 'INFECTED',
          detail: 'stream: Win.Test.EICAR_HDB-1 FOUND',
        } as ScanEngineResult;
      });

      const verdict = await service.scan(request());

      expect(completion?.failureReason).toContain('EICAR');
      expect(JSON.stringify(verdict)).not.toContain('EICAR');
    });
  });

  describe('a scanner that does not answer', () => {
    it('leaves the question open rather than refusing the file', async () => {
      engine.scan.mockImplementationOnce(async (source: unknown) => {
        for await (const _chunk of source as Readable) {
          void _chunk;
        }

        return { outcome: 'UNAVAILABLE', detail: 'timed out' };
      });

      const verdict = await service.scan(request());

      expect(completion?.state).toBe(FileScanAttemptState.FAILED);
      expect(completion?.rejectionCode).toBeNull();
      expect(verdict?.outcome).toBe('RETRY');
    });

    it('never reports a hash for bytes it could not vouch for', async () => {
      engine.scan.mockImplementationOnce(async (source: unknown) => {
        for await (const _chunk of source as Readable) {
          void _chunk;
        }

        return { outcome: 'UNAVAILABLE', detail: 'timed out' };
      });

      await service.scan(request());

      expect(completion?.observedSha256).toBeNull();
    });
  });

  describe('signatures that are too old to trust', () => {
    it.each([
      [
        'older than the policy allows',
        new Date(Date.now() - 72 * 60 * 60 * 1000),
      ],
      ['of an age the scanner would not state', null],
    ])('fails the attempt when they are %s', async (_label, builtAt) => {
      // ADR-0005 decision 4. Not a refusal: the file has done nothing wrong
      // and freshclam has. Refusing would reject every upload for as long as
      // an update was failing.
      engine.describe.mockImplementationOnce(() =>
        Promise.resolve({ ...description, definitionsBuiltAt: builtAt }),
      );

      const verdict = await service.scan(request());

      expect(completion?.state).toBe(FileScanAttemptState.FAILED);
      expect(completion?.failureReason).toContain('older than the policy');
      expect(verdict?.outcome).toBe('RETRY');
    });

    it('does not open the object at all', async () => {
      engine.describe.mockImplementationOnce(() =>
        Promise.resolve({ ...description, definitionsBuiltAt: null }),
      );

      await service.scan(request());

      expect(quarantine.getStream).not.toHaveBeenCalled();
      expect(engine.scan).not.toHaveBeenCalled();
    });
  });

  describe('bytes that are not the bytes the registry recorded', () => {
    it('refuses them however clean the scanner found them', async () => {
      // The case the second acceptance criterion is really about: an object
      // replaced between the request being queued and the object being
      // read. A clean answer about the wrong file is worse than no answer,
      // because it looks like one.
      const verdict = await service.scan(
        request({ expectedSha256: 'b'.repeat(64) }),
      );

      expect(engine.scan).toHaveBeenCalled();
      expect(completion?.state).toBe(FileScanAttemptState.REJECTED);
      expect(completion?.rejectionCode).toBe('HASH_MISMATCH');
      expect(verdict?.outcome).toBe('REJECTED');
    });

    it('records what it actually found', async () => {
      await service.scan(request({ expectedSha256: 'b'.repeat(64) }));

      expect(completion?.observedSha256).toBe(CONTENT_SHA);
    });
  });

  describe('an object that cannot be read', () => {
    it('refuses one that is not there', async () => {
      quarantine.getStream.mockImplementationOnce(() =>
        Promise.reject(new QuarantineObjectMissingError('gone')),
      );

      const verdict = await service.scan(request());

      expect(completion?.rejectionCode).toBe('OBJECT_MISSING');
      expect(verdict?.outcome).toBe('REJECTED');
    });

    it('refuses one that is larger than the worker will read', async () => {
      quarantine.getStream.mockImplementationOnce(() =>
        Promise.resolve(Readable.from([Buffer.alloc(2048)])),
      );

      const verdict = await service.scan(request());

      expect(completion?.rejectionCode).toBe('SIZE_LIMIT_EXCEEDED');
      expect(verdict?.outcome).toBe('REJECTED');
    });

    it('refuses an oversize object even if the scanner still answered', async () => {
      // Belt and braces. A size overflow normally arrives as a broken
      // stream, but an engine that swallowed the error and answered anyway
      // would otherwise have its clean verdict believed.
      quarantine.getStream.mockImplementationOnce(() =>
        Promise.resolve(Readable.from([Buffer.alloc(2048)])),
      );
      engine.scan.mockImplementationOnce(async (source: unknown) => {
        try {
          for await (const _chunk of source as Readable) {
            void _chunk;
          }
        } catch {
          // Swallowed, which is the point of this test.
        }

        return { outcome: 'CLEAN', detail: null };
      });

      await service.scan(request());

      expect(completion?.state).toBe(FileScanAttemptState.REJECTED);
      expect(completion?.rejectionCode).toBe('SIZE_LIMIT_EXCEEDED');
    });

    it('retries when the store itself was the problem', async () => {
      quarantine.getStream.mockImplementationOnce(() =>
        Promise.reject(new Error('connection reset')),
      );

      const verdict = await service.scan(request());

      expect(completion?.state).toBe(FileScanAttemptState.FAILED);
      expect(completion?.failureReason).toBe('connection reset');
      expect(verdict?.outcome).toBe('RETRY');
    });

    it('retries when something that is not an error is thrown', async () => {
      quarantine.getStream.mockImplementationOnce(() => Promise.reject('odd'));

      await service.scan(request());

      expect(completion?.failureReason).toBe('Unknown failure');
    });

    it('fails the attempt when the source breaks part way through', async () => {
      const breaking = new Readable({
        read() {
          this.push(Buffer.from('half'));
          this.destroy(new Error('the store went away'));
        },
      });

      quarantine.getStream.mockImplementationOnce(() =>
        Promise.resolve(breaking),
      );
      engine.scan.mockImplementationOnce(async (source: unknown) => {
        for await (const _chunk of source as Readable) {
          void _chunk;
        }

        return { outcome: 'CLEAN', detail: null };
      });

      const verdict = await service.scan(request());

      expect(verdict?.outcome).toBe('RETRY');
    });
  });

  describe('a lease that is no longer this worker’s', () => {
    it('says nothing when the attempt could not be started', async () => {
      attempts.markScanning.mockImplementationOnce(() =>
        Promise.resolve(false),
      );

      await expect(service.scan(request())).resolves.toBeNull();
      expect(quarantine.getStream).not.toHaveBeenCalled();
    });

    it('says nothing when the answer could not be written', async () => {
      // The compare-and-set failed, so another worker owns the question and
      // this one keeps quiet. That is what makes a stale completion
      // harmless rather than a second opinion.
      attempts.complete.mockImplementationOnce(() => Promise.resolve(null));

      await expect(service.scan(request())).resolves.toBeNull();
    });

    it('keeps the lease alive while the scan is still running', async () => {
      jest.useFakeTimers();

      try {
        let release: (() => void) | undefined;

        quarantine.getStream.mockImplementationOnce(() =>
          Promise.resolve(
            new Readable({
              read() {
                release = () => {
                  this.push(null);
                };
              },
            }),
          ),
        );

        const running = service.scan(
          request({ expectedSha256: 'e'.repeat(64) }),
        );

        await Promise.resolve();
        jest.advanceTimersByTime(30_000);
        await jest.runOnlyPendingTimersAsync();

        expect(attempts.heartbeat).toHaveBeenCalledWith(
          ATTEMPT_ID,
          LEASE_TOKEN,
        );

        release?.();
        await running;

        expect(completion?.state).not.toBe(FileScanAttemptState.CLEAN);
      } finally {
        jest.useRealTimers();
      }
    });

    it('tears the read down when the heartbeat itself fails', async () => {
      // A heartbeat that cannot reach the database is a lease this worker
      // can no longer prove it holds, which is the same situation as having
      // lost it.
      jest.useFakeTimers();

      try {
        attempts.heartbeat.mockImplementation(() =>
          Promise.reject(new Error('no database')),
        );
        quarantine.getStream.mockImplementationOnce(() =>
          Promise.resolve(
            new Readable({
              read() {
                // Never produces anything.
              },
            }),
          ),
        );
        engine.scan.mockImplementationOnce(async (source: unknown) => {
          try {
            for await (const _chunk of source as Readable) {
              void _chunk;
            }
          } catch (error) {
            return { outcome: 'UNAVAILABLE', detail: (error as Error).message };
          }

          return { outcome: 'CLEAN', detail: null };
        });

        const running = service.scan(request());

        await Promise.resolve();
        jest.advanceTimersByTime(30_000);
        await jest.runOnlyPendingTimersAsync();

        await running;

        expect(completion?.failureReason).toContain('could not be held');
      } finally {
        jest.useRealTimers();
      }
    });

    it('tears the read down when a heartbeat finds the lease gone', async () => {
      jest.useFakeTimers();

      try {
        attempts.heartbeat.mockImplementation(() => Promise.resolve(false));
        quarantine.getStream.mockImplementationOnce(() =>
          Promise.resolve(
            new Readable({
              read() {
                // Never produces anything, so only the heartbeat can end it.
              },
            }),
          ),
        );
        engine.scan.mockImplementationOnce(async (source: unknown) => {
          try {
            for await (const _chunk of source as Readable) {
              void _chunk;
            }
          } catch (error) {
            return { outcome: 'UNAVAILABLE', detail: (error as Error).message };
          }

          return { outcome: 'CLEAN', detail: null };
        });

        const running = service.scan(request());

        await Promise.resolve();
        jest.advanceTimersByTime(30_000);
        await jest.runOnlyPendingTimersAsync();

        await running;

        expect(completion?.state).toBe(FileScanAttemptState.FAILED);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('a message delivered more than once', () => {
    it('repeats the first answer rather than scanning again', async () => {
      attempts.claim.mockImplementationOnce(() =>
        Promise.resolve({
          kind: 'DUPLICATE',
          attempt: attempt({
            state: FileScanAttemptState.CLEAN,
            observedSha256: CONTENT_SHA,
          }),
        }),
      );

      const verdict = await service.scan(request());

      expect(verdict?.outcome).toBe('CLEAN');
      expect(engine.scan).not.toHaveBeenCalled();
      expect(attempts.complete).not.toHaveBeenCalled();
    });

    it('says nothing when another worker holds the attempt', async () => {
      attempts.claim.mockImplementationOnce(() =>
        Promise.resolve({ kind: 'BUSY' }),
      );

      await expect(service.scan(request())).resolves.toBeNull();
    });

    it('answers with the refusal when the retry budget has gone', async () => {
      attempts.claim.mockImplementationOnce(() =>
        Promise.resolve({
          kind: 'EXHAUSTED',
          attempt: attempt({
            state: FileScanAttemptState.REJECTED,
            rejectionCode: 'RETRY_BUDGET_EXHAUSTED',
          }),
        }),
      );

      const verdict = await service.scan(request());

      expect(verdict).toEqual(
        expect.objectContaining({
          outcome: 'REJECTED',
          rejectionCode: 'RETRY_BUDGET_EXHAUSTED',
        }),
      );
      expect(engine.scan).not.toHaveBeenCalled();
    });
  });

  describe('a scanner that cannot be reached at all', () => {
    it('lets the failure through so the message is delivered again', async () => {
      // Nothing can be written without a definition epoch, so there is no
      // attempt to fail. Rethrowing leaves the job in BullMQ's hands, which
      // is the only place it can be seen.
      engine.describe.mockImplementationOnce(() =>
        Promise.reject(new Error('ECONNREFUSED')),
      );

      await expect(service.scan(request())).rejects.toThrow('ECONNREFUSED');
      expect(attempts.claim).not.toHaveBeenCalled();
    });
  });
});
