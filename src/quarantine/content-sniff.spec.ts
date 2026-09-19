import { describe, expect, it } from '@jest/globals';

import { SNIFF_PREFIX_BYTES, sniffContentType } from './content-sniff';

/**
 * Builds a prefix whose first bytes are a marker.
 *
 * @param bytes - The marker.
 * @param offset - Where it starts.
 * @returns The prefix, padded to the sniffing length.
 */
function prefixWith(bytes: number[], offset = 0): Buffer {
  const buffer = Buffer.alloc(SNIFF_PREFIX_BYTES);
  Buffer.from(bytes).copy(buffer, offset);

  return buffer;
}

describe('sniffContentType', () => {
  it.each([
    ['a PNG', [0x89, 0x50, 0x4e, 0x47], 0, 'image/png'],
    ['a JPEG', [0xff, 0xd8, 0xff], 0, 'image/jpeg'],
    ['a GIF', [0x47, 0x49, 0x46, 0x38], 0, 'image/gif'],
    ['a WebP', [0x57, 0x45, 0x42, 0x50], 8, 'image/webp'],
    ['a bitmap', [0x42, 0x4d], 0, 'image/bmp'],
    ['a PDF', [0x25, 0x50, 0x44, 0x46], 0, 'application/pdf'],
    ['a ZIP', [0x50, 0x4b, 0x03, 0x04], 0, 'application/zip'],
    ['a gzip', [0x1f, 0x8b], 0, 'application/gzip'],
    ['a Windows executable', [0x4d, 0x5a], 0, 'application/x-msdownload'],
    ['an ELF binary', [0x7f, 0x45, 0x4c, 0x46], 0, 'application/x-executable'],
  ])('recognises %s', (_description, marker, offset, expected) => {
    expect(sniffContentType(prefixWith(marker, offset))).toBe(expected);
  });

  it('says nothing about a CSV, which has no signature to find', () => {
    // Deliberate. A roster export is plain text and looks like plain text,
    // and the worker reports what it saw rather than inventing a type it
    // cannot establish.
    expect(
      sniffContentType(
        Buffer.from('"Character Name","Account Handle"', 'utf8'),
      ),
    ).toBeNull();
  });

  it('says nothing about bytes that match nothing', () => {
    expect(sniffContentType(Buffer.from([0x01, 0x02, 0x03, 0x04]))).toBeNull();
  });

  it('says nothing about an empty prefix', () => {
    expect(sniffContentType(Buffer.alloc(0))).toBeNull();
  });

  it('does not read a marker that runs past the bytes it was given', () => {
    // A truncated WebP header is the case: the marker sits at offset eight,
    // and a prefix shorter than twelve bytes cannot carry it. Reading past
    // the end would compare against undefined and, with a different
    // comparison, could match.
    expect(sniffContentType(Buffer.from([0x52, 0x49, 0x46, 0x46]))).toBeNull();
  });

  it('does not mistake a WebP marker that is in the wrong place', () => {
    expect(
      sniffContentType(prefixWith([0x57, 0x45, 0x42, 0x50], 0)),
    ).toBeNull();
  });
});
