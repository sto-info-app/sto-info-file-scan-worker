/**
 * How many leading bytes are enough to recognise a container.
 *
 * Every signature below sits within the first thirty-two bytes, and the
 * longest offset used is the twelfth. The margin is there so that adding a
 * format does not also mean remembering to widen the buffer.
 */
export const SNIFF_PREFIX_BYTES = 64;

/** One thing worth recognising. */
interface Signature {
  /** The media type to report. */
  readonly contentType: string;
  /** Where in the prefix the marker starts. */
  readonly offset: number;
  /** The marker. */
  readonly marker: readonly number[];
}

/**
 * What the worker can recognise from a file's first bytes.
 *
 * Deliberately short. It exists to answer two questions and no others: what
 * arrived, and whether what arrived is the kind of thing the upload claimed
 * it was. The second is new in contract version 2, which carries the
 * declared type — ADR-0020 — and it is answered with this table rather than
 * with a library because the set of things this site accepts is four types
 * long.
 *
 * It replaces the `file-type` package, which the worker depended on and
 * could never have used: that package is ESM-only with no CommonJS entry
 * point, and this application compiles to CommonJS, so the import would have
 * failed the first time the pipeline ran. Thirty lines of table is a poor
 * substitute for a maintained library in general, and a better one here,
 * where the whole requirement is to write down what the first bytes said.
 *
 * A NUL-byte and control-byte test sits beside it, and it is worth being
 * clear about what that is and is not. The old CSV validation carried a
 * printable-ratio heuristic as part of deciding whether a roster export was
 * *well formed*; that belongs to the backend's ingress, where ADR-0001 puts
 * it and where FC-009 built it. This one decides only whether bytes are
 * plausibly text at all, which is the only way a declared `text/csv` can be
 * confirmed by anything the worker can see.
 */
const SIGNATURES: readonly Signature[] = [
  { contentType: 'image/png', offset: 0, marker: [0x89, 0x50, 0x4e, 0x47] },
  { contentType: 'image/jpeg', offset: 0, marker: [0xff, 0xd8, 0xff] },
  { contentType: 'image/gif', offset: 0, marker: [0x47, 0x49, 0x46, 0x38] },
  { contentType: 'image/webp', offset: 8, marker: [0x57, 0x45, 0x42, 0x50] },
  { contentType: 'image/bmp', offset: 0, marker: [0x42, 0x4d] },
  {
    contentType: 'application/pdf',
    offset: 0,
    marker: [0x25, 0x50, 0x44, 0x46],
  },
  // A ZIP header, which is also what an Office document and a JAR look like.
  // Reported as the container it is rather than guessed at, because the
  // difference lives in the archive's directory and this only sees its start.
  {
    contentType: 'application/zip',
    offset: 0,
    marker: [0x50, 0x4b, 0x03, 0x04],
  },
  { contentType: 'application/gzip', offset: 0, marker: [0x1f, 0x8b] },
  { contentType: 'application/x-msdownload', offset: 0, marker: [0x4d, 0x5a] },
  // ELF, which has no business being uploaded to any part of this site.
  {
    contentType: 'application/x-executable',
    offset: 0,
    marker: [0x7f, 0x45, 0x4c, 0x46],
  },
];

/** The prefix of any media type that is carried as text. */
const TEXT_TYPE_PREFIX = 'text/';

/** What a file's first bytes turned out to be evidence of. */
interface ByteEvidence {
  /** The container recognised, or null when none was. */
  readonly signature: string | null;
  /** Whether the bytes are plausibly text. */
  readonly looksLikeText: boolean;
}

/**
 * Reads whatever the first bytes are evidence of.
 *
 * Both questions are answered, and neither overrides the other, because the
 * two collide in a way that would otherwise be decided wrongly. `BM` and
 * `MZ` are printable letters: a roster CSV whose first cell begins with
 * either matches a binary signature while being perfectly good text. Keeping
 * the findings separate lets the caller use whichever one its question needs
 * — a declared `text/csv` is answered by the text test, and a declared
 * `image/bmp` by the signature — instead of forcing one label to serve both.
 *
 * @param prefix - The leading bytes, however many arrived.
 * @returns What they are evidence of.
 */
function examine(prefix: Buffer): ByteEvidence {
  const signature =
    SIGNATURES.find(candidate => matches(prefix, candidate))?.contentType ??
    null;

  return { signature, looksLikeText: looksLikeText(prefix) };
}

/**
 * Reports whether bytes are plausibly text.
 *
 * A NUL byte or a control byte that no text file uses is taken as proof that
 * they are not. Bytes above 0x7f are allowed, because a roster export is
 * UTF-8 and carries names that need it, and a byte-order mark is three of
 * them. An empty prefix is not text: nothing was read, so nothing was shown.
 *
 * @param prefix - The leading bytes.
 * @returns True when nothing in them contradicts text.
 */
function looksLikeText(prefix: Buffer): boolean {
  if (prefix.length === 0) {
    return false;
  }

  return prefix.every(
    byte => byte >= 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d,
  );
}

/**
 * Says what a file's first bytes look like, for the record.
 *
 * What is recorded, not what is decided — `declarationHolds` does the
 * deciding. A file recognised as a container is reported as that container,
 * unless it also reads as text, in which case the text is the better
 * description: the three signatures whose markers are printable letters
 * (`BM`, `MZ`, `GIF8`) would otherwise label an ordinary CSV as a bitmap.
 *
 * @param prefix - The leading bytes, however many arrived.
 * @returns The media type, or null when nothing recognised it.
 */
export function sniffContentType(prefix: Buffer): string | null {
  const evidence = examine(prefix);

  return evidence.looksLikeText ? 'text/plain' : evidence.signature;
}

/**
 * Reports whether the bytes support what the upload claimed they were.
 *
 * The rule is strict for anything that is not text and permissive about what
 * kind of text something is. A declared container must be the container its
 * signature says it is, so a PNG declared as a JPEG is refused and so is an
 * executable declared as an image. A declared `text/*` is confirmed by the
 * text test alone, because the difference between a CSV and a plain text
 * file is not in the bytes and the backend's ingress is what decides whether
 * a roster export is well formed.
 *
 * Silence is refusal, not permission. A declared type this table cannot
 * confirm — a container with no signature here, or bytes that are neither a
 * known container nor text — does not hold. The backend normalises what a
 * browser sends into the small set this can answer for, so the types that
 * reach here are types it knows; anything else is either a new upload path
 * that has not been thought about or a claim worth refusing.
 *
 * @param declaredContentType - What the upload claimed, already normalised.
 * @param prefix - The leading bytes, however many arrived.
 * @returns True when the bytes bear the claim out.
 */
export function declarationHolds(
  declaredContentType: string,
  prefix: Buffer,
): boolean {
  const evidence = examine(prefix);

  if (declaredContentType.startsWith(TEXT_TYPE_PREFIX)) {
    return evidence.looksLikeText;
  }

  return evidence.signature === declaredContentType;
}

/**
 * Reports whether a prefix carries a signature's marker.
 *
 * @param prefix - The leading bytes.
 * @param signature - The signature to test.
 * @returns True when it matches.
 */
function matches(prefix: Buffer, signature: Signature): boolean {
  const end = signature.offset + signature.marker.length;

  if (prefix.length < end) {
    return false;
  }

  return signature.marker.every(
    (byte, index) => prefix[signature.offset + index] === byte,
  );
}
