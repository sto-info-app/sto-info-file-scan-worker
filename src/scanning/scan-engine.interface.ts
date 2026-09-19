import { Readable } from 'node:stream';

/**
 * The injection token for whichever scanner this build uses.
 *
 * ADR-0005 decision 1 requires the engine to sit behind a neutral interface
 * "so this remains revisitable". The decision itself records why that matters
 * here rather than as a general principle: the plan had selected Cloudmersive,
 * the code had implemented ClamAV, and the next escalation named in that same
 * record — moving `clamd` out into its own Render service — changes how the
 * scanner is reached without changing anything about what a verdict means.
 */
export const SCAN_ENGINE = Symbol('SCAN_ENGINE');

/**
 * What a scanner says about itself.
 *
 * Every field is recorded as given and never filled in with a plausible
 * value. ADR-0005 decision 5: a scanner that does not expose a version is
 * recorded as having none, because "unknown" is a fact and a guess is not.
 */
export interface ScanEngineDescription {
  /** The scanner's name. */
  readonly engine: string;
  /** Its version, or null when it did not say. */
  readonly engineVersion: string | null;
  /** Its signature database's version, or null when it did not say. */
  readonly signatureVersion: string | null;
  /**
   * An opaque label for the signature database in use.
   *
   * Part of the idempotency key, so the same bytes scanned again after a
   * signature update are a new attempt rather than a duplicate of the last
   * one. Falls back to a stable placeholder when the scanner says nothing,
   * so that the key is always writable.
   */
  readonly definitionEpoch: string;
  /**
   * When the signature database was last built, when the scanner says.
   *
   * Null is not treated as fresh. ADR-0005 decision 4 lists "definitions
   * older than the configured maximum age" among the conditions that mean
   * not clean, and a scanner that will not say how old its definitions are
   * has not established that they are young.
   */
  readonly definitionsBuiltAt: Date | null;
}

/**
 * What a scanner concluded about one set of bytes.
 *
 * Four outcomes, and only the first of them permits publication. The other
 * three exist separately because the worker does different things with them:
 * a match is final, an unreadable payload is final, and an engine that could
 * not answer is worth asking again.
 */
export type ScanEngineOutcome =
  /** An affirmative clean verdict. The only one that can lead anywhere. */
  | 'CLEAN'
  /** The scanner matched a signature. */
  | 'INFECTED'
  /** An archive, an encrypted payload or a format it cannot open. */
  | 'UNSUPPORTED'
  /** It did not answer: a timeout, a refused connection, a protocol error. */
  | 'UNAVAILABLE';

/** What a scanner concluded, and what it said about it. */
export interface ScanEngineResult {
  /** The conclusion. */
  readonly outcome: ScanEngineOutcome;
  /**
   * The scanner's own words, for an administrator.
   *
   * A signature name lives here. It never reaches a response, a log line a
   * reader can see, or anything else outside this repository's own table —
   * ADR-0005 decision 6.
   */
  readonly detail: string | null;
}

/**
 * A malware scanner.
 *
 * Two methods, and the separation between them is deliberate: an attempt asks
 * what the scanner is before it asks what the scanner thinks, because the
 * signature database's identity is part of the attempt's idempotency key and
 * has to be known before a row can be written.
 */
export interface ScanEngine {
  /**
   * Asks the scanner what it is and how current its signatures are.
   *
   * @returns The scanner's account of itself.
   * @throws Error when the scanner cannot be reached.
   */
  describe(): Promise<ScanEngineDescription>;

  /**
   * Reads a stream of bytes and says whether they are clean.
   *
   * Implementations must fail closed. Anything other than an affirmative
   * clean answer — a timeout, an unparseable reply, a dropped connection —
   * is reported as `UNAVAILABLE` or `UNSUPPORTED`, never as `CLEAN`.
   *
   * @param source - The bytes. Consumed exactly once.
   * @returns What the scanner concluded.
   */
  scan(source: Readable): Promise<ScanEngineResult>;
}
