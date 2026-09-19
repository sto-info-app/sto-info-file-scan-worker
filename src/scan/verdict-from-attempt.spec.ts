import { describe, expect, it } from '@jest/globals';

import { parseScanVerdictMessage } from '../contract/file-scan-contract';
import { FileScanAttemptEntity } from './entities/file-scan-attempt.entity';
import { FileScanAttemptState } from './enums/file-scan-attempt-state.enum';
import { buildVerdictMessage } from './verdict-from-attempt';

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
    id: '7c9e1b2d-3a4f-4e5b-9c8d-1a2b3c4d5e6f',
    assetId: '4f1a0e2c-8b3d-4a59-9c21-6f7e5d4c3b2a',
    objectKey: 'prod/assets/4f1a0e2c-8b3d-4a59-9c21-6f7e5d4c3b2a',
    objectVersion: null,
    expectedSha256: 'a'.repeat(64),
    observedSha256: 'a'.repeat(64),
    byteSize: '128',
    detectedContentType: 'image/png',
    policyVersion: 1,
    definitionEpoch: '27412',
    campaignId: null,
    traceId: '0b5d4f6a-1c2e-4d3b-8a7f-9e8d7c6b5a40',
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

describe('buildVerdictMessage', () => {
  it('builds a message the contract accepts', () => {
    // The two senders — a scan that has just finished, and the recovery
    // pass that finds one that never reached the queue — share this
    // function so that neither can drift from the other.
    const verdict = buildVerdictMessage(attempt());

    expect(() => parseScanVerdictMessage(verdict)).not.toThrow();
  });

  it.each([
    [FileScanAttemptState.CLEAN, 'CLEAN'],
    [FileScanAttemptState.REJECTED, 'REJECTED'],
    [FileScanAttemptState.FAILED, 'RETRY'],
  ])('reports %s as %s', (state, outcome) => {
    const rejectionCode =
      state === FileScanAttemptState.REJECTED ? 'INFECTED' : null;

    expect(
      buildVerdictMessage(attempt({ state, rejectionCode }))?.outcome,
    ).toBe(outcome);
  });

  it.each([FileScanAttemptState.CLAIMED, FileScanAttemptState.SCANNING])(
    'says nothing about an attempt still in %s',
    state => {
      expect(
        buildVerdictMessage(attempt({ state, completedAt: null })),
      ).toBeNull();
    },
  );

  it('says nothing about an attempt with no completion time', () => {
    expect(buildVerdictMessage(attempt({ completedAt: null }))).toBeNull();
  });

  it('carries the attempt’s own trace by default', () => {
    expect(buildVerdictMessage(attempt())?.traceId).toBe(
      '0b5d4f6a-1c2e-4d3b-8a7f-9e8d7c6b5a40',
    );
  });

  it('carries the request’s trace when one is supplied', () => {
    const traceId = '11111111-2222-4333-8444-555555555555';

    expect(buildVerdictMessage(attempt(), traceId)?.traceId).toBe(traceId);
  });

  it('writes the completion time as an instant in UTC', () => {
    expect(buildVerdictMessage(attempt())?.scannedAt).toBe(
      '2026-09-19T12:00:00.000Z',
    );
  });

  it('carries neither the byte count nor the detected type', () => {
    // Both are answers to "what did a scanner see", which ADR-0015 puts in
    // the scan record rather than in the registry. A field nothing reads is
    // a field that goes wrong quietly.
    const verdict = buildVerdictMessage(attempt()) as unknown as Record<
      string,
      unknown
    >;

    expect(verdict).not.toHaveProperty('byteSize');
    expect(verdict).not.toHaveProperty('detectedContentType');
  });
});
