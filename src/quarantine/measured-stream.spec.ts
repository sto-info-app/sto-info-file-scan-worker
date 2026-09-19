import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { describe, expect, it } from '@jest/globals';

import { SNIFF_PREFIX_BYTES } from './content-sniff';
import { MeasuredStream, ObjectTooLargeError } from './measured-stream';

/**
 * Pushes bytes through a measured stream and collects what comes out.
 *
 * @param chunks - The bytes, in the chunks they arrive in.
 * @param maxBytes - The stream's limit.
 * @returns The stream and everything that passed through it.
 */
async function pass(
  chunks: Buffer[],
  maxBytes = 1024,
): Promise<{ measured: MeasuredStream; output: Buffer }> {
  const measured = new MeasuredStream(maxBytes);
  const collected: Buffer[] = [];

  await pipeline(
    Readable.from(chunks),
    measured,
    async function* (source) {
      for await (const chunk of source) {
        collected.push(chunk as Buffer);
        yield chunk;
      }
    },
    async function (source) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of source) {
        // Drained.
      }
    },
  );

  return { measured, output: Buffer.concat(collected) };
}

describe('MeasuredStream', () => {
  describe('measuring what passes', () => {
    it('forwards the bytes unchanged', async () => {
      const { output } = await pass([
        Buffer.from('hello '),
        Buffer.from('world'),
      ]);

      expect(output.toString('utf8')).toBe('hello world');
    });

    it('counts them', async () => {
      const { measured } = await pass([Buffer.alloc(10), Buffer.alloc(7)]);

      expect(measured.byteSize).toBe(17);
      expect(measured.exceeded).toBe(false);
    });

    it('hashes them, and agrees with a hash taken separately', async () => {
      const bytes = Buffer.from('a roster export, sanitised', 'utf8');
      const { measured } = await pass([bytes]);

      expect(measured.digest()).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      );
    });

    it('hashes a stream split across chunks the same as one whole', async () => {
      const whole = Buffer.from('0123456789abcdef', 'utf8');
      const split = [
        whole.subarray(0, 3),
        whole.subarray(3, 11),
        whole.subarray(11),
      ];

      const first = await pass([whole]);
      const second = await pass(split);

      expect(second.measured.digest()).toBe(first.measured.digest());
    });

    it('hashes an empty stream to the empty digest', async () => {
      const { measured } = await pass([]);

      expect(measured.digest()).toBe(createHash('sha256').digest('hex'));
      expect(measured.byteSize).toBe(0);
    });

    it('can be read twice without changing its answer', async () => {
      // The digest is taken from a copy of the hash rather than by
      // finalising it, so reading it does not destroy it.
      const { measured } = await pass([Buffer.from('twice')]);

      expect(measured.digest()).toBe(measured.digest());
    });
  });

  describe('keeping a prefix', () => {
    it('keeps the leading bytes for sniffing', async () => {
      const { measured } = await pass([Buffer.from([0x89, 0x50, 0x4e, 0x47])]);

      expect([...measured.prefix]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    });

    it('assembles a prefix that arrived in small pieces', async () => {
      const { measured } = await pass([
        Buffer.from([0x25]),
        Buffer.from([0x50, 0x44]),
        Buffer.from([0x46]),
      ]);

      expect([...measured.prefix]).toEqual([0x25, 0x50, 0x44, 0x46]);
    });

    it('stops at the sniffing limit however much arrives', async () => {
      const { measured } = await pass([Buffer.alloc(900, 0xab)], 4096);

      expect(measured.prefix.length).toBe(SNIFF_PREFIX_BYTES);
    });

    it('stops collecting once it has enough', async () => {
      const { measured } = await pass(
        [Buffer.alloc(SNIFF_PREFIX_BYTES, 1), Buffer.alloc(8, 2)],
        4096,
      );

      expect(measured.prefix.length).toBe(SNIFF_PREFIX_BYTES);
      expect(measured.prefix.every(byte => byte === 1)).toBe(true);
    });
  });

  describe('refusing an object that is too large', () => {
    it('stops at the limit', async () => {
      await expect(pass([Buffer.alloc(1025)], 1024)).rejects.toBeInstanceOf(
        ObjectTooLargeError,
      );
    });

    it('passes a stream of exactly the limit', async () => {
      const { measured } = await pass([Buffer.alloc(1024)], 1024);

      expect(measured.exceeded).toBe(false);
    });

    it('records that the limit was the reason', async () => {
      // The pipeline tells three broken-stream failures apart by type, and
      // this flag is the one that turns a broken stream into a refusal
      // rather than a retry.
      const measured = new MeasuredStream(4);

      await expect(
        pipeline(Readable.from([Buffer.alloc(8)]), measured),
      ).rejects.toBeInstanceOf(ObjectTooLargeError);

      expect(measured.exceeded).toBe(true);
    });

    it('names the limit it enforced', () => {
      const error = new ObjectTooLargeError(2048);

      expect(error.name).toBe('ObjectTooLargeError');
      expect(error.maxBytes).toBe(2048);
      expect(error.message).toBe('The object is larger than 2048 bytes');
    });
  });
});
