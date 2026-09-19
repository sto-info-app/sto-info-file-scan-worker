import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Job } from 'bullmq';

import { WorkerSettings } from '../../config/worker-settings';
import { ScanVerdictMessage } from '../../contract/file-scan-contract';
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
      'file-scan-contract-v1.json',
    ),
    'utf8',
  ),
);

const VERDICT = FIXTURE.verdicts.clean as ScanVerdictMessage;

/**
 * Builds a job carrying whatever body the test wants.
 *
 * @param data - The body.
 * @returns The job.
 */
function job(data: unknown): Job<unknown> {
  return { id: 'job-1', data } as Job<unknown>;
}

describe('FileScanProcessor', () => {
  let scan: jest.Mock;
  let publish: jest.Mock;
  let processor: FileScanProcessor;

  beforeEach(() => {
    scan = jest.fn(() => Promise.resolve(VERDICT));
    publish = jest.fn(() => Promise.resolve());

    processor = new FileScanProcessor(
      { scan } as unknown as FileScanService,
      { publish } as unknown as ScanVerdictPublisherService,
      { schemaVersion: 1 } as WorkerSettings,
    );
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
      await processor.process(job({ schemaVersion: 1, assetId: 'nope' }));

      expect(scan).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    });

    it('drops one written against a version this process does not speak', async () => {
      processor = new FileScanProcessor(
        { scan } as unknown as FileScanService,
        { publish } as unknown as ScanVerdictPublisherService,
        { schemaVersion: 0 } as WorkerSettings,
      );

      await processor.process(job(FIXTURE.request));

      expect(scan).not.toHaveBeenCalled();
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
