import { createHash, Hash } from 'node:crypto';
import { Transform, TransformCallback } from 'node:stream';

import { SNIFF_PREFIX_BYTES } from './content-sniff';

/**
 * Raised when an object is larger than the worker will read.
 *
 * A distinct type rather than a message, because the pipeline has to tell
 * three failures apart that all arrive as a broken stream: the object was too
 * large, the scanner went away, or the store did. The first is a refusal, the
 * other two are worth trying again, and guessing from an error message is how
 * a refusal quietly becomes a retry loop.
 */
export class ObjectTooLargeError extends Error {
  /**
   * Creates an instance of ObjectTooLargeError.
   *
   * @param maxBytes - The limit that was passed.
   */
  constructor(public readonly maxBytes: number) {
    super(`The object is larger than ${maxBytes} bytes`);
    this.name = 'ObjectTooLargeError';
  }
}

/**
 * A stream that hashes and counts what passes through it, and stops when too
 * much does.
 *
 * Three jobs in one pass, because the bytes only go past once. The object is
 * never held in memory and never written to disk: it is read from quarantine,
 * measured here, and handed to the scanner as it arrives. Reading it twice —
 * once to hash and once to scan — would also be reading it twice from the
 * store, and would leave a window in which the two reads could differ.
 *
 * It also keeps the first few dozen bytes, which is all that is needed to
 * say what kind of file arrived. Keeping them costs nothing and is the only
 * chance there is: by the time the scanner has answered, the bytes are gone.
 *
 * The hash is what binds a verdict to its bytes. The registry recorded a
 * SHA-256 when the object was stored; if what comes back out does not hash to
 * the same value then either the wrong object was fetched or the right one
 * changed, and in both cases the only safe answer is to refuse. That check is
 * the reason the count and the hash are taken here rather than trusted from
 * the store's own metadata.
 */
export class MeasuredStream extends Transform {
  private readonly _hash: Hash = createHash('sha256');
  private readonly _maxBytes: number;
  private readonly _prefix: Buffer[] = [];
  private _prefixBytes = 0;
  private _byteSize = 0;
  private _exceeded = false;

  /**
   * Creates an instance of MeasuredStream.
   *
   * @param maxBytes - The most this stream will pass before refusing.
   */
  constructor(maxBytes: number) {
    super();
    this._maxBytes = maxBytes;
  }

  /** How many bytes have passed through. */
  get byteSize(): number {
    return this._byteSize;
  }

  /** Whether the limit was reached. */
  get exceeded(): boolean {
    return this._exceeded;
  }

  /** The leading bytes, for recognising what kind of file arrived. */
  get prefix(): Buffer {
    return Buffer.concat(this._prefix);
  }

  /**
   * The hash of everything that passed through, as lowercase hexadecimal.
   *
   * Only meaningful once the stream has finished, and deliberately not
   * guarded against being read early: a caller that reads it early gets the
   * hash of a prefix, which is a hash of something, and the pipeline only
   * ever reads it after the stream has ended.
   */
  digest(): string {
    return this._hash.copy().digest('hex');
  }

  /**
   * Hashes, counts and forwards one chunk.
   *
   * @param chunk - The bytes.
   * @param _encoding - Unused; this stream is always in buffer mode.
   * @param callback - Called when the chunk has been handled.
   */
  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this._byteSize += chunk.length;

    if (this._byteSize > this._maxBytes) {
      this._exceeded = true;
      callback(new ObjectTooLargeError(this._maxBytes));

      return;
    }

    this._hash.update(chunk);
    this.keepPrefix(chunk);
    callback(null, chunk);
  }

  /**
   * Keeps the leading bytes, up to the sniffing limit.
   *
   * @param chunk - The bytes passing through.
   */
  private keepPrefix(chunk: Buffer): void {
    const wanted = SNIFF_PREFIX_BYTES - this._prefixBytes;

    if (wanted <= 0) {
      return;
    }

    const kept = chunk.subarray(0, wanted);
    this._prefix.push(Buffer.from(kept));
    this._prefixBytes += kept.length;
  }
}
