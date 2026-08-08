/**
 * Reader for Grim Dawn's `.arz` database archives.
 *
 * An `.arz` is the game's compiled record store: every DBR file the game ships
 * lives in here, keyed by its record path (`records/items/gearhead/c020_head.dbr`).
 * That key is the whole reason this parser exists — saves reference items *only*
 * by record path, and no third-party dump publishes that mapping (see the Stage 3
 * plan's Outcome section).
 *
 * Layout, all little-endian:
 *
 * ```
 *   0  u16  magic (2)
 *   2  u16  version (3)
 *   4  u32  record-table offset, relative to byte 24
 *   8  u32  record-table size
 *  12  u32  record count
 *  16  u32  string-table offset (absolute)
 *  20  u32  string-table size
 * ```
 *
 * The string table is `u32 count` followed by `count` × (`u32 len`, `len` bytes).
 * Every name, key and string value elsewhere is an index into it.
 *
 * A record-table entry is: `u32 nameIndex`, `u32 typeLen` + type bytes, `u32 dataOffset`,
 * `u32 compressedSize`, `u32 decompressedSize`, `u64 fileTime`. The
 * data at `24 + dataOffset` is an LZ4 *block* (no frame header) that decompresses
 * to a flat field stream: `u16 type`, `u16 count`, `u32 keyIndex`, then `count`
 * 4-byte values — int, float, string index, or bool by type.
 */

import { createHash } from 'node:crypto';

/** Field value types as encoded in a record's field stream. */
const enum FieldType {
  Int = 0,
  Float = 1,
  String = 2,
  Bool = 3,
}

export type ArzValue = number | string | number[] | string[];

export interface ArzRecord {
  /** DBR record path — the key saves use. */
  record: string;
  /** Template class, e.g. `ArmorProtective_Head`. */
  type: string;
  fields: Record<string, ArzValue>;
}

/**
 * Decompress one LZ4 block.
 *
 * Written out rather than pulled from npm: the block format is a dozen lines,
 * and `.arz` uses raw blocks (no frame, no checksums) with the decompressed size
 * already known from the record table, which is the one case where the format is
 * trivial. Sequences are `token` (4 bits literal length, 4 bits match length),
 * optional length extension bytes, literals, then a 2-byte little-endian back
 * offset. The final sequence has literals only.
 */
export function decompressLz4Block(src: Buffer, decompressedSize: number): Buffer {
  const dst = Buffer.allocUnsafe(decompressedSize);
  let s = 0;
  let d = 0;

  const extend = (n: number): number => {
    let more: number;
    do {
      if (s >= src.length) throw new Error('LZ4: truncated length extension');
      more = src[s++]!;
      n += more;
    } while (more === 255);
    return n;
  };

  while (s < src.length) {
    const token = src[s++]!;

    let literals = token >> 4;
    if (literals === 15) literals = extend(literals);
    if (s + literals > src.length || d + literals > dst.length) {
      throw new Error(`LZ4: literal run overruns buffer (src ${s}+${literals}/${src.length}, dst ${d}+${literals}/${dst.length})`);
    }
    src.copy(dst, d, s, s + literals);
    s += literals;
    d += literals;

    // The last sequence stops after its literals — no match follows.
    if (s >= src.length) break;

    const offset = src[s]! | (src[s + 1]! << 8);
    s += 2;
    if (offset === 0 || offset > d) throw new Error(`LZ4: bad match offset ${offset} at dst ${d}`);

    let matchLen = token & 15;
    if (matchLen === 15) matchLen = extend(matchLen);
    matchLen += 4; // minimum match length is 4

    if (d + matchLen > dst.length) throw new Error(`LZ4: match overruns output (${d}+${matchLen}/${dst.length})`);
    // Byte-by-byte on purpose: overlapping matches (offset < matchLen) are legal
    // and are how LZ4 encodes runs, so a bulk copy would be wrong.
    let ref = d - offset;
    for (let i = 0; i < matchLen; i++) dst[d++] = dst[ref++]!;
  }

  if (d !== decompressedSize) {
    throw new Error(`LZ4: produced ${d} bytes, record table declared ${decompressedSize}`);
  }
  return dst;
}

export interface ReadArzOptions {
  /** Keep only records whose path passes this test. Everything else is skipped
   *  without being decompressed, which is most of the file. */
  filter?: (record: string) => boolean;
}

/** Header magic; version 3 is what 1.3.x ships. */
const ARZ_MAGIC = 2;
const ARZ_VERSION = 3;

export function readArz(buf: Buffer, opts: ReadArzOptions = {}): Map<string, ArzRecord> {
  if (buf.length < 24) throw new Error(`not an .arz archive: ${buf.length} bytes is shorter than the header`);
  const magic = buf.readUInt16LE(0);
  const version = buf.readUInt16LE(2);
  if (magic !== ARZ_MAGIC) throw new Error(`not an .arz archive: magic ${magic} != ${ARZ_MAGIC}`);
  if (version !== ARZ_VERSION) throw new Error(`unsupported .arz version ${version} (expected ${ARZ_VERSION})`);

  const recordTableStart = buf.readUInt32LE(4);
  const recordCount = buf.readUInt32LE(12);
  const stringTableStart = buf.readUInt32LE(16);

  const strings = readStringTable(buf, stringTableStart);
  const out = new Map<string, ArzRecord>();

  let p = recordTableStart;
  for (let i = 0; i < recordCount; i++) {
    const nameIndex = buf.readUInt32LE(p);
    p += 4;
    const typeLen = buf.readUInt32LE(p);
    p += 4;
    const type = buf.toString('latin1', p, p + typeLen);
    p += typeLen;
    const dataOffset = buf.readUInt32LE(p);
    p += 4;
    const compressedSize = buf.readUInt32LE(p);
    p += 4;
    const decompressedSize = buf.readUInt32LE(p);
    p += 4;
    p += 8; // u64 file time

    const record = strings[nameIndex];
    if (record === undefined) throw new Error(`record ${i}: name index ${nameIndex} is outside the string table`);
    if (opts.filter && !opts.filter(record)) continue;

    const data = decompressLz4Block(
      buf.subarray(24 + dataOffset, 24 + dataOffset + compressedSize),
      decompressedSize,
    );
    out.set(record, { record, type, fields: readFields(data, strings, record) });
  }

  return out;
}

function readStringTable(buf: Buffer, start: number): string[] {
  let p = start;
  const count = buf.readUInt32LE(p);
  p += 4;
  const strings = new Array<string>(count);
  for (let i = 0; i < count; i++) {
    const len = buf.readUInt32LE(p);
    p += 4;
    // latin1: DBR text is ASCII, and the localized strings we care about come
    // from the l10n tables, not from here.
    strings[i] = buf.toString('latin1', p, p + len);
    p += len;
  }
  return strings;
}

function readFields(data: Buffer, strings: string[], record: string): Record<string, ArzValue> {
  const fields: Record<string, ArzValue> = {};
  let q = 0;
  while (q + 8 <= data.length) {
    const type = data.readUInt16LE(q);
    const count = data.readUInt16LE(q + 2);
    const keyIndex = data.readUInt32LE(q + 4);
    q += 8;

    const key = strings[keyIndex];
    if (key === undefined) throw new Error(`${record}: field key index ${keyIndex} is outside the string table`);

    const values: (number | string)[] = [];
    for (let j = 0; j < count; j++) {
      switch (type) {
        case FieldType.Float:
          values.push(data.readFloatLE(q));
          break;
        case FieldType.String: {
          const idx = data.readUInt32LE(q);
          const s = strings[idx];
          if (s === undefined) throw new Error(`${record}.${key}: string index ${idx} is outside the string table`);
          values.push(s);
          break;
        }
        case FieldType.Bool:
        case FieldType.Int:
        default:
          values.push(data.readInt32LE(q));
          break;
      }
      q += 4;
    }
    fields[key] = count === 1 ? values[0]! : (values as number[] | string[]);
  }
  return fields;
}

/** Convenience accessors — DBR fields are loosely typed and often absent. */
export function str(rec: ArzRecord | undefined, key: string): string | undefined {
  const v = rec?.fields[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

export function num(rec: ArzRecord | undefined, key: string): number | undefined {
  const v = rec?.fields[key];
  return typeof v === 'number' ? v : undefined;
}

export function strList(rec: ArzRecord | undefined, key: string): string[] {
  const v = rec?.fields[key];
  if (typeof v === 'string') return v === '' ? [] : [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x !== '');
  return [];
}

/** Short, stable id for a set of archive files — the cache key for a game build. */
export function fingerprint(parts: string[]): string {
  return createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 12);
}
