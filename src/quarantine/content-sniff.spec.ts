import { describe, expect, it } from '@jest/globals';

import {
  declarationHolds,
  SNIFF_PREFIX_BYTES,
  sniffContentType,
} from './content-sniff';

/**
 * Builds a prefix whose first bytes are a marker.
 *
 * The padding is NUL bytes, which is what a real binary file's header looks
 * like and is also what keeps these prefixes from reading as text.
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

/** A line out of a roster export. */
const CSV_PREFIX = Buffer.from(
  '"Character Name","Account Handle","Rank"\n',
  'utf8',
);

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

  it('describes a roster export as text', () => {
    // A CSV has no signature to find, so the only honest thing to record is
    // that the bytes are text. That is also the only evidence a declared
    // `text/csv` can ever be confirmed by.
    expect(sniffContentType(CSV_PREFIX)).toBe('text/plain');
  });

  it('describes UTF-8 beyond ASCII as text', () => {
    // A roster carries names that need it, and a byte-order mark is three
    // bytes above 0x7f before the first character.
    expect(sniffContentType(Buffer.from('﻿"Ambassador Sorvak"', 'utf8'))).toBe(
      'text/plain',
    );
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
    // comparison, could match. Those four bytes spell RIFF, so what comes
    // back is the text finding rather than nothing at all.
    expect(sniffContentType(Buffer.from([0x52, 0x49, 0x46, 0x46]))).toBe(
      'text/plain',
    );
  });

  it('does not mistake a WebP marker that is in the wrong place', () => {
    expect(
      sniffContentType(prefixWith([0x57, 0x45, 0x42, 0x50], 0)),
    ).toBeNull();
  });

  it('describes text that begins with printable marker letters as text', () => {
    // `BM` is a bitmap's signature and it is also two ordinary letters. A
    // roster whose first cell begins with them is text, and recording it as
    // a bitmap would be wrong in the record as well as in the comparison.
    expect(sniffContentType(Buffer.from('BM Fleet,Rank\n', 'utf8'))).toBe(
      'text/plain',
    );
  });
});

describe('declarationHolds', () => {
  it.each([
    ['a PNG declared as one', 'image/png', [0x89, 0x50, 0x4e, 0x47]],
    ['a JPEG declared as one', 'image/jpeg', [0xff, 0xd8, 0xff]],
    ['a PDF declared as one', 'application/pdf', [0x25, 0x50, 0x44, 0x46]],
  ])('holds for %s', (_description, declared, marker) => {
    expect(declarationHolds(declared, prefixWith(marker))).toBe(true);
  });

  it.each([
    ['a GIF declared as a PNG', 'image/png', [0x47, 0x49, 0x46, 0x38]],
    [
      'an executable declared as an image',
      'image/jpeg',
      [0x4d, 0x5a, 0x90, 0x00],
    ],
    ['a ZIP declared as a PDF', 'application/pdf', [0x50, 0x4b, 0x03, 0x04]],
  ])('does not hold for %s', (_description, declared, marker) => {
    expect(declarationHolds(declared, prefixWith(marker))).toBe(false);
  });

  it('does not hold for a container the table cannot confirm', () => {
    // Silence is refusal. An `application/vnd.ms-excel` has no signature
    // here, so nothing in the bytes bears the claim out — which is why the
    // backend reduces the spellings it can before they get this far.
    expect(declarationHolds('application/vnd.ms-excel', CSV_PREFIX)).toBe(
      false,
    );
  });

  it('does not hold for a container declared over text', () => {
    expect(declarationHolds('image/png', CSV_PREFIX)).toBe(false);
  });

  it.each([
    ['text/csv', CSV_PREFIX],
    ['text/plain', Buffer.from('just some words', 'utf8')],
    ['text/csv', Buffer.from('BM Fleet,Rank\n', 'utf8')],
  ])('holds for %s over bytes that read as text', (declared, prefix) => {
    expect(declarationHolds(declared, prefix)).toBe(true);
  });

  it.each([
    [
      'a PNG declared as a CSV',
      'text/csv',
      prefixWith([0x89, 0x50, 0x4e, 0x47]),
    ],
    [
      'an executable declared as a CSV',
      'text/csv',
      prefixWith([0x4d, 0x5a, 0x90, 0x00]),
    ],
    [
      'bytes that are neither text nor anything known',
      'text/csv',
      Buffer.from([0x01, 0x02, 0x03, 0x04]),
    ],
    ['an empty object declared as a CSV', 'text/csv', Buffer.alloc(0)],
  ])('does not hold for %s', (_description, declared, prefix) => {
    expect(declarationHolds(declared, prefix)).toBe(false);
  });
});
