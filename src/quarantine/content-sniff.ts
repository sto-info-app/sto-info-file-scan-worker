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
 * Deliberately short. This list exists to report what arrived, not to decide
 * whether it is allowed: the request message carries no expected type, and
 * the worker has no way of knowing what the feature that accepted the upload
 * was expecting. Deciding is FC-012's, against the registry's own record.
 *
 * It replaces the `file-type` package, which the worker depended on and
 * could never have used: that package is ESM-only with no CommonJS entry
 * point, and this application compiles to CommonJS, so the import would have
 * failed the first time the pipeline ran. Thirty lines of table is a poor
 * substitute for a maintained library in general, and a better one here,
 * where the whole requirement is to write down what the first bytes said.
 *
 * It also replaces the printable-ratio and NUL-byte heuristics the old CSV
 * validation carried. Those were part of deciding whether a roster export
 * was well formed, which ADR-0001 places at the backend's ingress and FC-009
 * built there.
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

/**
 * Says what a file's first bytes look like.
 *
 * @param prefix - The leading bytes, however many arrived.
 * @returns The media type, or null when nothing recognised it.
 */
export function sniffContentType(prefix: Buffer): string | null {
  for (const signature of SIGNATURES) {
    if (matches(prefix, signature)) {
      return signature.contentType;
    }
  }

  return null;
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
