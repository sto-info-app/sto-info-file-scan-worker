import { Logger } from '@nestjs/common';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { Job, Queue } from 'bullmq';

import { ScanVerdictMessage } from '../../contract/file-scan-contract';
import { FileScanAttemptEntity } from '../entities/file-scan-attempt.entity';
import { FileScanAttemptState } from '../enums/file-scan-attempt-state.enum';
import { FileScanAttemptService } from './file-scan-attempt.service';
import {
  ScanVerdictPublisherService,
  verdictJobId,
} from './scan-verdict-publisher.service';

const ATTEMPT_ID = '7c9e1b2d-3a4f-4e5b-9c8d-1a2b3c4d5e6f';

/** The job identifier the verdict below is sent under. */
const JOB_ID = `${ATTEMPT_ID}_${Date.parse('2026-09-19T12:00:00.000Z')}`;

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
  let getJob: jest.Mock<(jobId: string) => Promise<Job | undefined>>;
  let markVerdictPublished: jest.Mock;
  let findUnpublishedVerdicts: jest.Mock;
  let service: ScanVerdictPublisherService;

  beforeEach(() => {
    add = jest.fn(() => Promise.resolve({}));
    getJob = jest.fn(() => Promise.resolve(undefined));
    markVerdictPublished = jest.fn(() => Promise.resolve());
    findUnpublishedVerdicts = jest.fn(() => Promise.resolve([]));

    service = new ScanVerdictPublisherService(
      { add, getJob } as unknown as Queue,
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
        expect.objectContaining({ jobId: JOB_ID }),
      );
    });

    it('keys the job on the attempt and the answer, with no colon', () => {
      expect(verdictJobId(VERDICT)).toBe(JOB_ID);
      expect(verdictJobId(VERDICT)).not.toContain(':');
    });

    it('gives a reopened attempt’s new answer a job of its own', () => {
      // Under one identifier a clean answer after a RETRY would collapse into
      // the RETRY while it waited, or revive it if the backend had failed it
      // (FC-042).
      expect(
        verdictJobId({ ...VERDICT, scannedAt: '2026-09-19T12:05:00.000Z' }),
      ).not.toBe(verdictJobId(VERDICT));
    });

    it('records as sent the answer it sent, by when it was given', async () => {
      await service.publish(VERDICT);

      expect(markVerdictPublished).toHaveBeenCalledWith(
        ATTEMPT_ID,
        VERDICT.scannedAt,
      );
    });

    it('keys the job on the answer, so BullMQ collapses a repeat', async () => {
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

  describe('a verdict whose earlier job the backend failed', () => {
    let retry: jest.Mock<(state: string, options: object) => Promise<void>>;
    let failed: boolean;

    beforeEach(() => {
      failed = true;
      retry = jest.fn(() => Promise.resolve());
      getJob.mockImplementation(() =>
        Promise.resolve({
          isFailed: () => Promise.resolve(failed),
          retry,
        } as unknown as Job),
      );
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('sends the failed job round again, with its attempts restored', async () => {
      // BullMQ ignores an add whose identifier is already in the queue, in
      // any state, and failed verdict jobs are kept. Adding would silently
      // do nothing and leave the upload waiting for good.
      await service.publish(VERDICT);

      expect(getJob).toHaveBeenCalledWith(JOB_ID);
      expect(retry).toHaveBeenCalledWith('failed', {
        resetAttemptsMade: true,
        resetAttemptsStarted: true,
      });
      expect(add).not.toHaveBeenCalled();
    });

    it('records it as sent, and says it went round again', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      await service.publish(VERDICT);

      expect(markVerdictPublished).toHaveBeenCalledWith(
        ATTEMPT_ID,
        VERDICT.scannedAt,
      );
      expect(warn).toHaveBeenCalledWith(
        `[publish] Failed verdict sent round again - AttemptId: ${ATTEMPT_ID}`,
      );
    });

    it('adds as usual when the job is there but has not failed', async () => {
      // Waiting or running: the add collapses into it, which is the point
      // of keying the job on the attempt.
      failed = false;

      await service.publish(VERDICT);

      expect(retry).not.toHaveBeenCalled();
      expect(add).toHaveBeenCalledTimes(1);
    });

    it('does not mark it sent when the retry was refused', async () => {
      retry.mockImplementationOnce(() => Promise.reject(new Error('gone')));

      await expect(service.publish(VERDICT)).rejects.toThrow('gone');
      expect(markVerdictPublished).not.toHaveBeenCalled();
    });

    it('counts a stranded verdict sent round again as resent', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      findUnpublishedVerdicts.mockImplementationOnce(() =>
        Promise.resolve([attempt()]),
      );

      await expect(service.resendStrandedVerdicts()).resolves.toBe(1);
      expect(retry).toHaveBeenCalledTimes(1);
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

      // Counted as nothing: the sweep reads a full batch as a sign there
      // are more, and a row it skipped was not sent.
      await expect(service.resendStrandedVerdicts()).resolves.toBe(0);
      expect(add).not.toHaveBeenCalled();
    });

    it('counts only the rows it sent when some were skipped', async () => {
      findUnpublishedVerdicts.mockImplementationOnce(() =>
        Promise.resolve([
          attempt({ state: FileScanAttemptState.SCANNING, completedAt: null }),
          attempt(),
        ]),
      );

      await expect(service.resendStrandedVerdicts()).resolves.toBe(1);
      expect(add).toHaveBeenCalledTimes(1);
    });
  });
});
