import { ScanOutcome } from '../../contract/file-scan-contract';
import { FileScanAttemptState } from '../enums/file-scan-attempt-state.enum';

/**
 * Which outcome each finished attempt reports, and what the registry does
 * with it.
 *
 * ADR-0015 left this undone and named it: the worker's states "do not map
 * onto the registry's ten", and until FC-010 did the work "nothing enforces
 * the relationship between the two tables". This is that map, written once
 * and used by the only code that builds a verdict.
 *
 * | Attempt state | Outcome | The registry then reaches |
 * | --- | --- | --- |
 * | `CLEAN` | `CLEAN` | `CLEAN` — and not `AVAILABLE` |
 * | `REJECTED` | `REJECTED` | `REJECTED` |
 * | `FAILED` | `RETRY` | `RETRY_PENDING` |
 * | `CLAIMED`, `SCANNING` | — | nothing; the attempt has not finished |
 *
 * The third column is what the backend does, not what this repository does.
 * It is recorded here because the whole value of the map is that the two
 * vocabularies can be read side by side, and a reader who has to open the
 * other repository to do that will not.
 *
 * **`CLEAN` reaches `CLEAN` and stops.** Publication needs an allowed type,
 * successful processing and an audience, none of which a scanner knows.
 * ADR-0015 decision 3: they are two separate calls and cannot be collapsed
 * into one.
 *
 * **An unfinished attempt sends nothing at all.** A worker that lost its
 * lease has nothing to say about the object, because another worker may
 * already be looking at it. Staying quiet is what makes a stale completion
 * harmless, and it is why this map answers with null rather than with a
 * cautious guess.
 */
export const FINISHED_ATTEMPT_OUTCOMES: Readonly<
  Partial<Record<FileScanAttemptState, ScanOutcome>>
> = {
  [FileScanAttemptState.CLEAN]: 'CLEAN',
  [FileScanAttemptState.REJECTED]: 'REJECTED',
  [FileScanAttemptState.FAILED]: 'RETRY',
};

/**
 * Reports which outcome a finished attempt sends, if it sends one.
 *
 * @param state - The state the attempt finished in.
 * @returns The outcome to report, or null when the attempt reports nothing.
 */
export function outcomeForAttemptState(
  state: FileScanAttemptState,
): ScanOutcome | null {
  return FINISHED_ATTEMPT_OUTCOMES[state] ?? null;
}
