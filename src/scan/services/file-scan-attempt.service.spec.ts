import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { IsNull, Repository } from 'typeorm';

import { WorkerSettings } from '../../config/worker-settings';
import { ScanRequestMessage } from '../../contract/file-scan-contract';
import { ScanEngineDescription } from '../../scanning/scan-engine.interface';
import { FileScanAttemptEntity } from '../entities/file-scan-attempt.entity';
import { FileScanAttemptState } from '../enums/file-scan-attempt-state.enum';
import { FileScanAttemptService } from './file-scan-attempt.service';

const SETTINGS = {
  leaseMs: 300_000,
  maxAttempts: 3,
} as WorkerSettings;

const REQUEST: ScanRequestMessage = {
  schemaVersion: 2,
  assetId: '4f1a0e2c-8b3d-4a59-9c21-6f7e5d4c3b2a',
  objectKey: 'prod/assets/4f1a0e2c-8b3d-4a59-9c21-6f7e5d4c3b2a',
  objectVersion: null,
  expectedSha256: 'a'.repeat(64),
  declaredContentType: 'text/csv',
  policyVersion: 1,
  campaignId: null,
  traceId: '0b5d4f6a-1c2e-4d3b-8a7f-9e8d7c6b5a40',
};

/** When the backend queued the request. */
const REQUESTED_AT = new Date('2026-09-26T10:00:00.000Z');

const DESCRIPTION: ScanEngineDescription = {
  engine: 'clamav',
  engineVersion: '1.4.2',
  signatureVersion: '27412',
  definitionEpoch: '27412',
  definitionsBuiltAt: new Date('2026-09-18T09:15:22.000Z'),
};

/**
 * Builds an attempt row.
 *
 * @param changes - Fields to override.
 * @returns The row.
 */
function attempt(
  changes: Partial<FileScanAttemptEntity> = {},
): FileScanAttemptEntity {
  return {
    id: '7c9e1b2d-3a4f-4e5b-9c8d-1a2b3c4d5e6f',
    assetId: REQUEST.assetId,
    objectKey: REQUEST.objectKey,
    objectVersion: null,
    expectedSha256: REQUEST.expectedSha256,
    observedSha256: null,
    byteSize: null,
    detectedContentType: null,
    policyVersion: 1,
    definitionEpoch: '27412',
    campaignId: null,
    traceId: REQUEST.traceId,
    state: FileScanAttemptState.CLAIMED,
    rejectionCode: null,
    failureReason: null,
    engine: 'clamav',
    engineVersion: '1.4.2',
    signatureVersion: '27412',
    definitionsBuiltAt: new Date('2026-09-18T09:15:22.000Z'),
    requestedAt: REQUESTED_AT,
    attemptCount: 1,
    leaseToken: 'e3b0c442-98fc-4c14-9afb-f4c8996fb924',
    leaseExpiresAt: new Date(),
    heartbeatAt: new Date(),
    startedAt: null,
    completedAt: null,
    verdictPublishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...changes,
  } as FileScanAttemptEntity;
}

describe('FileScanAttemptService', () => {
  let query: jest.Mock;
  let findOne: jest.Mock;
  let service: FileScanAttemptService;

  beforeEach(() => {
    // Shaped as TypeORM's PostgreSQL driver shapes it: an UPDATE answers
    // `[rows, rowCount]`, anything else answers the rows. A mock that gave
    // an UPDATE bare rows is what let every compare-and-set here read as
    // lost against a real database while passing here.
    query = jest.fn((statement: unknown) =>
      Promise.resolve(updated(statement as string) ? [[], 0] : []),
    );
    findOne = jest.fn(() => Promise.resolve(null));

    service = new FileScanAttemptService(
      { query, findOne } as unknown as Repository<FileScanAttemptEntity>,
      SETTINGS,
    );
  });

  /**
   * Whether a statement is an UPDATE, which the driver answers differently.
   *
   * @param statement - The SQL.
   * @returns True for an UPDATE.
   */
  function updated(statement: string): boolean {
    return statement.trimStart().startsWith('UPDATE');
  }

  /**
   * The SQL of the nth statement the service ran.
   *
   * @param index - Which statement.
   * @returns The SQL, with its whitespace collapsed.
   */
  function sql(index = 0): string {
    return (query.mock.calls[index][0] as string).replace(/\s+/g, ' ');
  }

  /**
   * The parameters of the nth statement the service ran.
   *
   * @param index - Which statement.
   * @returns The parameters.
   */
  function parameters(index = 0): unknown[] {
    return query.mock.calls[index][1] as unknown[];
  }

  describe('claiming an attempt', () => {
    it('takes the attempt when the insert lands', async () => {
      const row = attempt();
      query.mockImplementationOnce(() => Promise.resolve([row]));

      await expect(
        service.claim(REQUEST, DESCRIPTION, REQUESTED_AT),
      ).resolves.toEqual({
        kind: 'CLAIMED',
        attempt: row,
      });
    });

    it('inserts and takes over in one statement', async () => {
      // Two statements — look, then write — would leave a gap wide enough
      // for two workers to both decide they had won.
      query.mockImplementationOnce(() => Promise.resolve([attempt()]));

      await service.claim(REQUEST, DESCRIPTION, REQUESTED_AT);

      expect(sql()).toContain('INSERT INTO');
      expect(sql()).toContain(
        'ON CONFLICT ON CONSTRAINT "UQ_file_scan_attempt_idempotency"',
      );
      expect(sql()).toContain('DO UPDATE SET');
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('records when the request was queued and when the signatures were built', async () => {
      // The wait the diagnostics page reports starts at the request, not at
      // the moment a worker happened to pick the job up.
      query.mockImplementationOnce(() => Promise.resolve([attempt()]));

      await service.claim(REQUEST, DESCRIPTION, REQUESTED_AT);

      expect(sql()).toContain('"definitionsBuiltAt", "requestedAt"');
      expect(sql()).toContain(
        '"definitionsBuiltAt" = EXCLUDED."definitionsBuiltAt"',
      );
      expect(sql()).not.toContain('"requestedAt" = EXCLUDED');
      expect(parameters().slice(14)).toEqual([
        DESCRIPTION.definitionsBuiltAt,
        REQUESTED_AT,
      ]);
    });

    it('will only take over an attempt whose lease has lapsed', async () => {
      query.mockImplementationOnce(() => Promise.resolve([attempt()]));

      await service.claim(REQUEST, DESCRIPTION, REQUESTED_AT);

      expect(sql()).toContain(`"state" IN ('CLAIMED', 'SCANNING')`);
      expect(sql()).toContain('"leaseExpiresAt" IS NULL');
      expect(sql()).toContain('"leaseExpiresAt" < now()');
    });

    it('issues a fresh lease token every time', async () => {
      query.mockImplementation(() => Promise.resolve([attempt()]));

      await service.claim(REQUEST, DESCRIPTION, REQUESTED_AT);
      await service.claim(REQUEST, DESCRIPTION, REQUESTED_AT);

      expect(parameters(0)[11]).not.toBe(parameters(1)[11]);
    });

    it('keys the attempt on the signature database that answered', async () => {
      query.mockImplementationOnce(() => Promise.resolve([attempt()]));

      await service.claim(REQUEST, DESCRIPTION, REQUESTED_AT);

      expect(parameters()[5]).toBe('27412');
    });

    it('repeats a finished attempt rather than scanning again', async () => {
      const finished = attempt({
        state: FileScanAttemptState.CLEAN,
        completedAt: new Date(),
      });

      findOne.mockImplementationOnce(() => Promise.resolve(finished));

      await expect(
        service.claim(REQUEST, DESCRIPTION, REQUESTED_AT),
      ).resolves.toEqual({
        kind: 'DUPLICATE',
        attempt: finished,
      });
    });

    it('looks the existing attempt up by the whole idempotency key', async () => {
      findOne.mockImplementationOnce(() =>
        Promise.resolve(attempt({ completedAt: new Date() })),
      );

      await service.claim(REQUEST, DESCRIPTION, REQUESTED_AT);

      expect(findOne).toHaveBeenCalledWith({
        where: {
          assetId: REQUEST.assetId,
          objectVersion: IsNull(),
          policyVersion: 1,
          definitionEpoch: '27412',
        },
      });
    });

    it('matches a stored version rather than a null when there is one', async () => {
      findOne.mockImplementationOnce(() =>
        Promise.resolve(attempt({ completedAt: new Date() })),
      );

      await service.claim(
        { ...REQUEST, objectVersion: 'v7' },
        DESCRIPTION,
        REQUESTED_AT,
      );

      expect(findOne).toHaveBeenCalledWith({
        where: expect.objectContaining({ objectVersion: 'v7' }),
      });
    });

    it('says nothing when another worker holds a live lease', async () => {
      findOne.mockImplementationOnce(() =>
        Promise.resolve(attempt({ attemptCount: 1 })),
      );

      await expect(
        service.claim(REQUEST, DESCRIPTION, REQUESTED_AT),
      ).resolves.toEqual({
        kind: 'BUSY',
      });
    });

    it('says nothing when the row vanished between the two statements', async () => {
      await expect(
        service.claim(REQUEST, DESCRIPTION, REQUESTED_AT),
      ).resolves.toEqual({
        kind: 'BUSY',
      });
    });

    it('refuses an attempt that has used its budget', async () => {
      const spent = attempt({ attemptCount: 3 });
      const refused = attempt({
        attemptCount: 3,
        state: FileScanAttemptState.REJECTED,
        rejectionCode: 'RETRY_BUDGET_EXHAUSTED',
        completedAt: new Date(),
      });

      findOne.mockImplementationOnce(() => Promise.resolve(spent));
      query.mockImplementationOnce(() => Promise.resolve([]));
      query.mockImplementationOnce(() => Promise.resolve([[refused], 1]));

      await expect(
        service.claim(REQUEST, DESCRIPTION, REQUESTED_AT),
      ).resolves.toEqual({
        kind: 'EXHAUSTED',
        attempt: refused,
      });
      expect(sql(1)).toContain(`"rejectionCode" = 'RETRY_BUDGET_EXHAUSTED'`);
    });

    it('leaves an exhausted attempt alone while somebody is holding it', async () => {
      // The budget is there to stop attempts accumulating, not to interrupt
      // the one that is about to answer.
      findOne.mockImplementationOnce(() =>
        Promise.resolve(attempt({ attemptCount: 3 })),
      );

      await expect(
        service.claim(REQUEST, DESCRIPTION, REQUESTED_AT),
      ).resolves.toEqual({
        kind: 'BUSY',
      });
      expect(sql(1)).toContain('"leaseExpiresAt" < now()');
    });
  });

  describe('marking an attempt as scanning', () => {
    it('reports success when this worker still holds it', async () => {
      query.mockImplementationOnce(() => Promise.resolve([[{ id: 'x' }], 1]));

      await expect(service.markScanning('attempt-1', 'token')).resolves.toBe(
        true,
      );
      expect(sql()).toContain(`"state" = 'SCANNING'`);
      expect(sql()).toContain('"leaseToken" = $2');
    });

    it('reports failure when the lease has gone', async () => {
      await expect(service.markScanning('attempt-1', 'token')).resolves.toBe(
        false,
      );
    });
  });

  describe('holding the lease', () => {
    it('extends it while this worker still owns it', async () => {
      query.mockImplementationOnce(() => Promise.resolve([[{ id: 'x' }], 1]));

      await expect(service.heartbeat('attempt-1', 'token')).resolves.toBe(true);
      expect(parameters()).toEqual(['attempt-1', 'token', '300000']);
    });

    it('reports failure when somebody else has taken it', async () => {
      await expect(service.heartbeat('attempt-1', 'token')).resolves.toBe(
        false,
      );
    });

    it('gives the lease up without finishing the attempt', async () => {
      await service.release('attempt-1', 'token');

      expect(sql()).toContain('"leaseToken" = NULL');
      expect(sql()).not.toContain('"completedAt"');
      expect(sql()).not.toContain(`"state" =`);
    });
  });

  describe('completing an attempt', () => {
    const completion = {
      state: FileScanAttemptState.CLEAN,
      observedSha256: 'a'.repeat(64),
      byteSize: 12,
      detectedContentType: 'image/png',
      rejectionCode: null,
      failureReason: null,
      engineVersion: '1.4.2',
      signatureVersion: '27412',
      definitionsBuiltAt: new Date('2026-09-18T09:15:22.000Z'),
    };

    it('records when the signatures it answered with were built', async () => {
      query.mockImplementationOnce(() => Promise.resolve([[attempt()], 1]));

      await service.complete('attempt-1', 'token', completion);

      expect(sql()).toContain('"definitionsBuiltAt" = $11');
      expect(parameters()[10]).toEqual(completion.definitionsBuiltAt);
    });

    it('writes the answer and clears the lease in one statement', async () => {
      const finished = attempt({
        state: FileScanAttemptState.CLEAN,
        completedAt: new Date(),
      });
      query.mockImplementationOnce(() => Promise.resolve([[finished], 1]));

      await expect(
        service.complete('attempt-1', 'token', completion),
      ).resolves.toBe(finished);

      expect(sql()).toContain('"leaseToken" = NULL');
      expect(sql()).toContain('"completedAt" = now()');
    });

    it('only writes when the lease token still matches', async () => {
      query.mockImplementationOnce(() => Promise.resolve([[attempt()], 1]));

      await service.complete('attempt-1', 'token', completion);

      expect(sql()).toContain(
        `WHERE "id" = $1 AND "leaseToken" = $2 AND "state" IN ('CLAIMED', 'SCANNING')`,
      );
    });

    it('says nothing when the lease was lost', async () => {
      // The second acceptance criterion. A worker that stalled long enough
      // to lose its lease updates no rows, and its answer — which may be
      // about bytes that have since been replaced — never leaves here.
      await expect(
        service.complete('attempt-1', 'token', completion),
      ).resolves.toBeNull();
    });
  });

  describe('the recovery path', () => {
    it('marks a verdict published only once', async () => {
      await service.markVerdictPublished('attempt-1');

      expect(sql()).toContain('"verdictPublishedAt" IS NULL');
    });

    it('finds finished attempts whose verdict never went out', async () => {
      const stranded = [attempt({ completedAt: new Date() })];
      query.mockImplementationOnce(() => Promise.resolve(stranded));

      await expect(service.findUnpublishedVerdicts(50)).resolves.toBe(stranded);

      expect(sql()).toContain('"verdictPublishedAt" IS NULL');
      expect(sql()).toContain('"completedAt" IS NOT NULL');
      expect(parameters()).toEqual([50]);
    });
  });

  describe('holding no transaction open', () => {
    it.each([
      ['a manager transaction', '.transaction('],
      ['a query runner', 'createQueryRunner'],
      ['an explicit begin', 'startTransaction'],
      ['a row lock', 'FOR UPDATE'],
    ])('never opens %s', (_description, forbidden) => {
      // The third acceptance criterion, as a property of the whole service
      // rather than of any one method: there is no transaction to leave open
      // across a scan, because nothing here opens one. A SELECT ... FOR
      // UPDATE around an attempt would hold a row lock for as long as ClamAV
      // takes on a ten-megabyte file.
      const source = readFileSync(
        join(__dirname, 'file-scan-attempt.service.ts'),
        'utf8',
      ).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

      expect(source).not.toContain(forbidden);
    });
  });
});
