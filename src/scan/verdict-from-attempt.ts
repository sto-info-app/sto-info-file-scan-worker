import {
  FILE_SCAN_CONTRACT_VERSION,
  ScanRejectionCode,
  ScanVerdictMessage,
} from '../contract/file-scan-contract';
import { outcomeForAttemptState } from './constants/scan-outcome.constants';
import { FileScanAttemptEntity } from './entities/file-scan-attempt.entity';

/**
 * Turns a finished attempt into the message the backend reads.
 *
 * One function, used by both things that send a verdict: the scan that has
 * just finished one, and the recovery pass that finds one which finished but
 * never reached the queue. They must produce identical messages — a recovery
 * that resent a subtly different verdict would be worse than one that resent
 * nothing, because the difference would only show up in whichever asset
 * happened to be in flight when Redis went away.
 *
 * @param attempt - The attempt.
 * @param traceId - The identifier to carry, when the request supplied one.
 * @returns The verdict, or null when the attempt has not finished.
 */
export function buildVerdictMessage(
  attempt: FileScanAttemptEntity,
  traceId: string = attempt.traceId,
): ScanVerdictMessage | null {
  const outcome = outcomeForAttemptState(attempt.state);

  if (outcome === null || attempt.completedAt === null) {
    return null;
  }

  return {
    schemaVersion: FILE_SCAN_CONTRACT_VERSION,
    assetId: attempt.assetId,
    attemptId: attempt.id,
    objectKey: attempt.objectKey,
    objectVersion: attempt.objectVersion,
    expectedSha256: attempt.expectedSha256,
    observedSha256: attempt.observedSha256,
    policyVersion: attempt.policyVersion,
    definitionEpoch: attempt.definitionEpoch,
    outcome,
    rejectionCode: attempt.rejectionCode as ScanRejectionCode | null,
    engine: attempt.engine,
    engineVersion: attempt.engineVersion,
    signatureVersion: attempt.signatureVersion,
    scannedAt: new Date(attempt.completedAt).toISOString(),
    traceId,
  };
}
