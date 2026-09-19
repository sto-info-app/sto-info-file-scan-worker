import { describe, expect, it } from '@jest/globals';

import { FileScanAttemptState } from '../enums/file-scan-attempt-state.enum';
import {
  FINISHED_ATTEMPT_OUTCOMES,
  outcomeForAttemptState,
} from './scan-outcome.constants';

describe('the map from an attempt to an outcome', () => {
  it.each([
    [FileScanAttemptState.CLEAN, 'CLEAN'],
    [FileScanAttemptState.REJECTED, 'REJECTED'],
    [FileScanAttemptState.FAILED, 'RETRY'],
  ])('reports %s as %s', (state, outcome) => {
    expect(outcomeForAttemptState(state)).toBe(outcome);
  });

  it.each([FileScanAttemptState.CLAIMED, FileScanAttemptState.SCANNING])(
    'reports nothing for %s',
    state => {
      // An unfinished attempt says nothing at all. A cautious guess here
      // would be a verdict about an object another worker may be holding.
      expect(outcomeForAttemptState(state)).toBeNull();
    },
  );

  it('covers every state the enum declares', () => {
    // ADR-0015 left this map undone and named it: the worker's states "do
    // not map onto the registry's ten". A state added later without a
    // decision about what it means fails here.
    const mapped = new Set([
      ...Object.keys(FINISHED_ATTEMPT_OUTCOMES),
      FileScanAttemptState.CLAIMED,
      FileScanAttemptState.SCANNING,
    ]);

    expect([...Object.values(FileScanAttemptState)].sort()).toEqual(
      [...mapped].sort(),
    );
  });

  it('never maps anything to a state a scanner cannot reach', () => {
    // A clean verdict reaches CLEAN and stops. AVAILABLE is not in this
    // vocabulary at all, which is ADR-0015 decision 3 as an absence.
    expect(Object.values(FINISHED_ATTEMPT_OUTCOMES)).not.toContain('AVAILABLE');
  });
});
