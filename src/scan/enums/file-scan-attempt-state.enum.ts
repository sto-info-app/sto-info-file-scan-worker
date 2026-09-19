/**
 * Where one attempt to scan one object has got to.
 *
 * Five values, and none of them is a publication state. That is the whole
 * distinction ADR-0015 draws: this table answers "what did a scanner say,
 * and when, and with which signatures", and `file_asset` answers "may this be
 * served". The worker cannot reach the second question from here, which is
 * the authority boundary expressed as a schema rather than as a rule.
 *
 * This replaces the seven states the old `upload_files` row carried
 * (`UPLOADED`, `VALIDATING`, `VALIDATION_FAILED`, `SCANNING`, `INFECTED`,
 * `PASSED`, `ERROR`). Those mixed the progress of an upload with the outcome
 * of a scan, which is why they never mapped onto the registry's ten.
 *
 * There is deliberately no state for "a worker went away". An earlier draft
 * had one and nothing could ever write it: the worker that loses its lease is
 * by definition the worker whose writes the database refuses, so it cannot
 * record its own departure, and the worker that takes the attempt over writes
 * to the same row, so there is nothing left to mark. What happened is visible
 * anyway, in the attempt count and the lease columns.
 */
export enum FileScanAttemptState {
  /**
   * The attempt is leased to a worker and the bytes have not been opened.
   *
   * A row in this state whose lease has expired is free for another worker to
   * take. That is the entire reclaim mechanism, and it is why the lease has
   * an expiry rather than a holder.
   */
  CLAIMED = 'CLAIMED',

  /** The scanner has the bytes and has not yet answered. */
  SCANNING = 'SCANNING',

  /**
   * The scanner returned an affirmative clean verdict for exactly these bytes.
   *
   * "Exactly these bytes" is enforced rather than assumed: a `CLEAN` row must
   * carry an observed hash equal to the expected one, and the database
   * refuses a row that does not.
   */
  CLEAN = 'CLEAN',

  /**
   * The attempt refused, and no retry will change that.
   *
   * An infection, a hash that did not match, an oversize object, a payload
   * the scanner cannot open, a missing object, or a retry budget that ran
   * out. All of them carry a rejection code, and none of them is ever shown
   * to the person who uploaded the file.
   */
  REJECTED = 'REJECTED',

  /**
   * The scanner did not answer, and the question is still open.
   *
   * A timeout, an unreachable engine, a signature database too old to trust.
   * Not an answer, so not clean — ADR-0005 decision 4 — but worth asking
   * again, which is what separates it from {@link REJECTED}.
   */
  FAILED = 'FAILED',
}
