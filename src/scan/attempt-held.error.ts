/**
 * Raised when a job asks for an attempt that another worker holds a live
 * lease on.
 *
 * The job must not simply finish. Nothing would deliver it again, so if the
 * holder has gone — a crash, an out-of-memory kill, an instance replaced
 * mid-scan — the upload would wait in `SCANNING` until the backend's nightly
 * sweep abandoned it. The processor puts the job back until the lease lapses
 * instead. By then either the holder has answered, and the next delivery
 * repeats that verdict, or it has gone, and the next delivery takes the
 * attempt over.
 */
export class AttemptHeldError extends Error {
  /**
   * Creates an instance of AttemptHeldError.
   *
   * @param leaseExpiresAt - When the holder's lease lapses, or null when the
   *   holder's row could not be read.
   */
  constructor(readonly leaseExpiresAt: Date | null) {
    super('Another worker holds this attempt');
    this.name = 'AttemptHeldError';
  }
}
