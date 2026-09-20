import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Queue } from 'bullmq';

import { ScanVerdictMessage } from '../../contract/file-scan-contract';
import { FileScanAttemptEntity } from '../entities/file-scan-attempt.entity';
import { FileScanAttemptState } from '../enums/file-scan-attempt-state.enum';
import { FileScanAttemptService } from './file-scan-attempt.service';
import { ScanVerdictPublisherService } from './scan-verdict-publisher.service';

const ATTEMPT_ID = '7c9e1b2d-3a4f-4e5b-9c8d-1a2b3c4d5e6f';

const VERDICT: ScanVerdictMessage = {
  schemaVersion: 2,
  assetId: '4f1a0e2c-8b3d-4a59-9c21-6f7e5d4c3b2a',
  attemptId: ATTEMPT_ID,
  objectKey: 'prod/assets/4f1a0e2c-8b3d-4a59-9c21-6f7e5d4c3b2a',
  objectVersion: null,
  expectedSha256: 'a'.repeat(64),
  observedSha256: 'a'.repeat(64),
  policyVersion: 1,
  definitionEpoch: '27412',
  outcome: 'CLEAN',
  rejectionCode: null,
  engine: 'clamav',
  engineVersion: '1.4.2',
  signatureVersion: '27412',
  scannedAt: '2026-09-19T12:00:00.000Z',
  traceId: '0b5d4f6a-1c2e-4d3b-8a7f-9e8d7c6b5a40',
};

/**
 * Builds a finished attempt.
 *
 * @param changes - Fields to override.
 * @returns The row.
 */
function attempt(
  changes: Partial<FileScanAttemptEntity> = {},
): FileScanAttemptEntity {
  return {
    id: ATTEMPT_ID,
    assetId: VERDICT.assetId,
    objectKey: VERDICT.objectKey,
    objectVersion: null,
    expectedSha256: VERDICT.expectedSha256,
    observedSha256: VERDICT.observedSha256,
    byteSize: '128',
    detectedContentType: null,
    policyVersion: 1,
    definitionEpoch: '27412',
    campaignId: null,
    traceId: VERDICT.traceId,
    state: FileScanAttemptState.CLEAN,
    rejectionCode: null,
    failureReason: null,
    engine: 'clamav',
    engineVersion: '1.4.2',
    signatureVersion: '27412',
    attemptCount: 1,
    leaseToken: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    startedAt: null,
    completedAt: new Date('2026-09-19T12:00:00.000Z'),
    verdictPublishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...changes,
  } as FileScanAttemptEntity;
}

describe('ScanVerdictPublisherService', () => {
  let add: jest.Mock;
  let markVerdictPublished: jest.Mock;
  let findUnpublishedVerdicts: jest.Mock;
  let service: ScanVerdictPublisherService;

  beforeEach(() => {
    add = jest.fn(() => Promise.resolve({}));
    markVerdictPublished = jest.fn(() => Promise.resolve());
    findUnpublishedVerdicts = jest.fn(() => Promise.resolve([]));

    service = new ScanVerdictPublisherService(
      { add } as unknown as Queue,
      {
        markVerdictPublished,
        findUnpublishedVerdicts,
      } as unknown as FileScanAttemptService,
    );
  });

  describe('sending a verdict', () => {
    it('puts it on the queue under the job name the contract fixes', async () => {
      await service.publish(VERDICT);

      expect(add).toHaveBeenCalledWith(
        'record-verdict',
        VERDICT,
        expect.objectContaining({ jobId: ATTEMPT_ID }),
      );
    });

    it('keys the job on the attempt, so BullMQ collapses a repeat', async () => {
      await service.publish(VERDICT);
      await service.publish(VERDICT);

      const jobIds = add.mock.calls.map(
        call => (call[2] as { jobId: string }).jobId,
      );

      expect(new Set(jobIds).size).toBe(1);
    });

    it('sends before it records having sent', async () => {
      // The wrong way round on purpose. A crash between the two leaves a
      // verdict that may be delivered twice, which the backend's state
      // machine refuses; the other order would lose it outright, and a lost
      // verdict is an upload that never finishes for anybody.
      await service.publish(VERDICT);

      expect(add.mock.invocationCallOrder[0]).toBeLessThan(
        markVerdictPublished.mock.invocationCallOrder[0],
      );
    });

    it('does not mark it sent when the queue refused it', async () => {
      add.mockImplementationOnce(() => Promise.reject(new Error('no redis')));

      await expect(service.publish(VERDICT)).rejects.toThrow('no redis');
      expect(markVerdictPublished).not.toHaveBeenCalled();
    });
  });

  describe('recovering verdicts that never went out', () => {
    it('finds nothing to do when there is nothing stranded', async () => {
      await expect(service.resendStrandedVerdicts()).resolves.toBe(0);
      expect(add).not.toHaveBeenCalled();
    });

    it('resends each one', async () => {
      // ADR-0006 accepted Redis becoming load-bearing for file safety and
      // named this recovery as the main new risk it introduced. It reads
      // from PostgreSQL, which is where the authoritative answer is.
      findUnpublishedVerdicts.mockImplementationOnce(() =>
        Promise.resolve([attempt(), attempt({ id: ATTEMPT_ID })]),
      );

      await expect(service.resendStrandedVerdicts()).resolves.toBe(2);
      expect(add).toHaveBeenCalledTimes(2);
    });

    it('resends exactly what the first send would have been', async () => {
      findUnpublishedVerdicts.mockImplementationOnce(() =>
        Promise.resolve([attempt()]),
      );

      await service.resendStrandedVerdicts();

      expect(add.mock.calls[0][1]).toEqual(VERDICT);
    });

    it('skips a row that has not finished', async () => {
      findUnpublishedVerdicts.mockImplementationOnce(() =>
        Promise.resolve([
          attempt({
            state: FileScanAttemptState.SCANNING,
            completedAt: null,
          }),
        ]),
      );

      await expect(service.resendStrandedVerdicts()).resolves.toBe(1);
      expect(add).not.toHaveBeenCalled();
    });
  });
});
