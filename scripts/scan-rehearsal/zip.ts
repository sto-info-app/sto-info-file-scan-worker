/**
 * Builds the small ZIP archives the scan rehearsal feeds to `clamd`.
 *
 * Written out by hand rather than taken from a package because the
 * rehearsal needs archives no tidy library will make: nested past the
 * scanner's recursion limit, holding more members than it will open, and
 * encrypted with the legacy PKWARE cipher ClamAV reports as
 * `Heuristics.Encrypted.Zip`, and deflated members that expand past the
 * scanner's per-file limit from a few hundred kilobytes.
 *
 * Rehearsal-only. Nothing in the worker reads or writes archives.
 */

import { deflateRawSync } from 'node:zlib';

/** One file inside an archive. */
export interface ZipMember {
  /** The member's name. */
  readonly name: string;

  /** The member's bytes. */
  readonly data: Buffer;

  /** Deflates the member rather than storing it. */
  readonly deflate?: boolean;
}

/** The CRC-32 table, built once. */
const CRC_TABLE = Array.from({ length: 256 }, (_unused, index) => {
  let value = index;

  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }

  return value >>> 0;
});

/**
 * Updates a CRC-32 with one byte.
 *
 * @param crc - The running value.
 * @param byte - The byte.
 * @returns The new running value.
 */
function crcByte(crc: number, byte: number): number {
  return (CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0;
}

/**
 * Computes the CRC-32 ZIP records for a member.
 *
 * @param data - The bytes.
 * @returns The checksum.
 */
function crc32(data: Buffer): number {
  let crc = 0xffffffff;

  for (const byte of data) {
    crc = crcByte(crc, byte);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Encrypts a member with the traditional PKWARE cipher.
 *
 * The twelve-byte header ends with the high byte of the member's CRC, which
 * is how an unzip tool checks a password before it reads anything.
 *
 * @param data - The member's bytes.
 * @param crc - The member's CRC-32.
 * @param password - The password.
 * @returns The header and the encrypted bytes.
 */
function encrypt(data: Buffer, crc: number, password: string): Buffer {
  const keys = [0x12345678, 0x23456789, 0x34567890];

  const update = (byte: number): void => {
    keys[0] = crcByte(keys[0], byte);
    keys[1] = (keys[1] + (keys[0] & 0xff)) >>> 0;
    keys[1] = (Math.imul(keys[1], 134775813) + 1) >>> 0;
    keys[2] = crcByte(keys[2], keys[1] >>> 24);
  };

  const streamByte = (): number => {
    const temp = (keys[2] | 2) & 0xffff;

    return (Math.imul(temp, temp ^ 1) >>> 8) & 0xff;
  };

  for (const byte of Buffer.from(password, 'utf8')) {
    update(byte);
  }

  const plain = Buffer.concat([
    Buffer.alloc(11, 0x5a),
    Buffer.from([crc >>> 24]),
    data,
  ]);
  const out = Buffer.alloc(plain.length);

  plain.forEach((byte, index) => {
    out[index] = byte ^ streamByte();
    update(byte);
  });

  return out;
}

/**
 * Builds a ZIP archive.
 *
 * @param members - The files to put in it.
 * @param password - Encrypts every member when given.
 * @returns The archive's bytes.
 */
export function zip(members: readonly ZipMember[], password?: string): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const member of members) {
    const name = Buffer.from(member.name, 'utf8');
    const crc = crc32(member.data);
    const packed = member.deflate ? deflateRawSync(member.data) : member.data;
    const body =
      password === undefined ? packed : encrypt(packed, crc, password);
    const flags = password === undefined ? 0 : 1;
    const method = member.deflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(10, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(member.data.length, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(10, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(member.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

/**
 * Wraps bytes in an archive inside an archive, `depth` times over.
 *
 * @param data - The innermost file.
 * @param depth - How many archives deep to put it.
 * @returns The outermost archive.
 */
export function nest(data: Buffer, depth: number): Buffer {
  let current = zip([{ name: 'inner.txt', data }]);

  for (let level = 1; level < depth; level += 1) {
    current = zip([{ name: `level-${level}.zip`, data: current }]);
  }

  return current;
}
