/**
 * Reader for Grim Dawn's `.arc` asset archives.
 *
 * Where `.arz` holds the game's records, `.arc` holds its files — textures,
 * meshes, animations, localization tables. Stage 4 needs `resources/Items.arc`
 * to turn a record's `bitmap` field into an actual icon; `resources/Text_EN.arc`
 * is the same reader away from dropping the last GrimTools dependency.
 *
 * Layout, all little-endian:
 *
 * ```
 *   0  char[4]  magic 'ARC\0'
 *   4  u32      version (3)
 *   8  u32      file-entry count
 *  12  u32      chunk count
 *  16  u32      chunk-table size, bytes
 *  20  u32      string-table size, bytes
 *  24  u32      table offset — chunk table, string table and file entries, in
 *               that order, all at the tail of the file
 * ```
 *
 * A file entry is 44 bytes: `u32 storage`, `u32 offset`, `u32 compressedSize`,
 * `u32 decompressedSize`, `u32 hash`, `u64 fileTime`, `u32 chunkCount`,
 * `u32 firstChunk`, `u32 nameLength`, `u32 nameOffset` (the last two index the
 * string table). A chunk-table entry is `u32 offset`, `u32 compressedSize`,
 * `u32 decompressedSize`; a chunk whose two sizes are equal is stored verbatim,
 * anything else is an LZ4 block — same encoding `.arz` uses.
 *
 * Bulk data stays on disk: an archive is opened by file descriptor and only its
 * tables are read up front (a few hundred KB against a 450 MB `Items.arc`), so
 * extracting one icon reads one icon's worth of bytes.
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs';

import { decompressLz4Block } from './arz.js';

const HEADER_SIZE = 28;
const ENTRY_SIZE = 44;
const CHUNK_SIZE = 12;
const ARC_MAGIC = 'ARC\0';
const ARC_VERSION = 3;

export interface ArcEntry {
  /** In-archive path, e.g. `enchants/enchantm_black.tex`. Always as stored. */
  name: string;
  offset: number;
  compressedSize: number;
  decompressedSize: number;
  chunkCount: number;
  firstChunk: number;
}

export class ArcArchive {
  private readonly index = new Map<string, ArcEntry>();
  private fd: number | undefined;

  private constructor(
    readonly path: string,
    fd: number,
    private readonly chunkTable: Buffer,
  ) {
    this.fd = fd;
  }

  /**
   * Open an archive and read its tables. Throws if the file is not an `.arc`;
   * callers that treat a missing archive as ordinary should check first.
   */
  static open(path: string): ArcArchive {
    const fd = openSync(path, 'r');
    try {
      const header = readAt(fd, 0, HEADER_SIZE);
      const magic = header.toString('latin1', 0, 4);
      if (magic !== ARC_MAGIC) {
        throw new Error(`not an .arc archive: magic ${JSON.stringify(magic)} != "ARC\\0"`);
      }
      const version = header.readUInt32LE(4);
      if (version !== ARC_VERSION) throw new Error(`unsupported .arc version ${version} (expected ${ARC_VERSION})`);

      const entryCount = header.readUInt32LE(8);
      const chunkTableSize = header.readUInt32LE(16);
      const stringTableSize = header.readUInt32LE(20);
      const tableOffset = header.readUInt32LE(24);

      // The three tables occupy the whole tail; if they do not, the file is
      // truncated or the layout is not what we think it is. Say so now rather
      // than read nonsense offsets later.
      const expectedSize = tableOffset + chunkTableSize + stringTableSize + entryCount * ENTRY_SIZE;
      const actualSize = statSync(path).size;
      if (expectedSize !== actualSize) {
        throw new Error(`${path}: tables end at ${expectedSize} but the file is ${actualSize} bytes`);
      }

      const chunkTable = readAt(fd, tableOffset, chunkTableSize);
      const stringTable = readAt(fd, tableOffset + chunkTableSize, stringTableSize);
      const entries = readAt(fd, tableOffset + chunkTableSize + stringTableSize, entryCount * ENTRY_SIZE);

      const archive = new ArcArchive(path, fd, chunkTable);
      for (let i = 0; i < entryCount; i++) {
        const p = i * ENTRY_SIZE;
        const nameOffset = entries.readUInt32LE(p + 40);
        const name = stringTable.toString('latin1', nameOffset, nameOffset + entries.readUInt32LE(p + 36));
        archive.index.set(name.toLowerCase(), {
          name,
          offset: entries.readUInt32LE(p + 4),
          compressedSize: entries.readUInt32LE(p + 8),
          decompressedSize: entries.readUInt32LE(p + 12),
          chunkCount: entries.readUInt32LE(p + 28),
          firstChunk: entries.readUInt32LE(p + 32),
        });
      }
      return archive;
    } catch (err) {
      closeSync(fd);
      throw err;
    }
  }

  /** Archives were authored on Windows, so lookups are case-insensitive. */
  find(name: string): ArcEntry | undefined {
    return this.index.get(name.toLowerCase());
  }

  get size(): number {
    return this.index.size;
  }

  names(): string[] {
    return [...this.index.values()].map((e) => e.name);
  }

  /** Extract one file, or undefined when the archive does not contain it. */
  read(name: string): Buffer | undefined {
    const entry = this.find(name);
    return entry ? this.readEntry(entry) : undefined;
  }

  readEntry(entry: ArcEntry): Buffer {
    const fd = this.fd;
    if (fd === undefined) throw new Error(`${this.path} is closed`);

    // No chunks means the file is small enough to be stored whole.
    if (entry.chunkCount === 0) return readAt(fd, entry.offset, entry.compressedSize);

    const out = Buffer.allocUnsafe(entry.decompressedSize);
    let written = 0;
    for (let i = 0; i < entry.chunkCount; i++) {
      const p = (entry.firstChunk + i) * CHUNK_SIZE;
      const offset = this.chunkTable.readUInt32LE(p);
      const compressed = this.chunkTable.readUInt32LE(p + 4);
      const decompressed = this.chunkTable.readUInt32LE(p + 8);
      const raw = readAt(fd, offset, compressed);
      // Incompressible chunks are stored verbatim, flagged by equal sizes.
      const data = compressed === decompressed ? raw : decompressLz4Block(raw, decompressed);
      if (written + data.length > out.length) {
        throw new Error(`${this.path}: ${entry.name} chunks overrun its declared ${entry.decompressedSize} bytes`);
      }
      data.copy(out, written);
      written += data.length;
    }
    if (written !== entry.decompressedSize) {
      throw new Error(`${this.path}: ${entry.name} produced ${written} of ${entry.decompressedSize} bytes`);
    }
    return out;
  }

  close(): void {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
  }
}

/** `readSync` may return a short read; loop until the range is filled. */
function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const n = readSync(fd, buf, read, length - read, position + read);
    if (n === 0) throw new Error(`unexpected end of file reading ${length} bytes at ${position}`);
    read += n;
  }
  return buf;
}
