/**
 * Grim Dawn save-file cipher + reader.
 *
 * Save files (.gdc / .gst) are obfuscated with a seeded XOR stream cipher. The
 * running `state` advances over the *ciphertext* bytes, never the plaintext —
 * getting that backwards is the classic porting bug. Every block ends with a
 * checksum word that must equal the running state, which makes a passing
 * checksum proof that the block was consumed byte-for-byte correctly.
 *
 * Reused verbatim by the .gst parsers (stash / formulas).
 */

export class ChecksumError extends Error {
  constructor(
    readonly blockId: number,
    readonly expected: number,
    readonly actual: number,
    readonly offset: number,
  ) {
    super(
      `block ${blockId}: checksum mismatch at offset ${offset} ` +
        `(file 0x${expected.toString(16).padStart(8, '0')} != state 0x${actual.toString(16).padStart(8, '0')})`,
    );
    this.name = 'ChecksumError';
  }
}

export class TruncatedError extends Error {
  constructor(offset: number, need: number, size: number) {
    super(`truncated save: wanted ${need} byte(s) at offset ${offset}, file is ${size} bytes`);
    this.name = 'TruncatedError';
  }
}

/** A saved (offset, state) pair, so a speculative decode can be rewound. */
export interface ReaderMark {
  readonly offset: number;
  readonly state: number;
}

export interface BlockStart {
  readonly id: number;
  readonly length: number;
  /** Offset of the first body byte. */
  readonly bodyStart: number;
  /** Offset one past the last body byte — where the trailing checksum lives. */
  readonly bodyEnd: number;
}

const TABLE_SIZE = 256;

/**
 * Build the 256-entry key table from the seed:
 *   v = seed; repeat: v = rotr32(v, 1) * 39916801
 */
function buildTable(seed: number): Uint32Array {
  const table = new Uint32Array(TABLE_SIZE);
  let v = seed >>> 0;
  for (let i = 0; i < TABLE_SIZE; i++) {
    v = (((v << 31) | (v >>> 1)) >>> 0);
    v = Math.imul(v, 39916801) >>> 0;
    table[i] = v;
  }
  return table;
}

export class GdReader {
  private readonly buf: Buffer;
  private readonly table: Uint32Array;
  private pos: number;
  private state: number;

  constructor(buf: Buffer) {
    if (buf.length < 4) throw new TruncatedError(0, 4, buf.length);
    this.buf = buf;
    const seed = (buf.readUInt32LE(0) ^ 0x55555555) >>> 0;
    this.table = buildTable(seed);
    this.state = seed;
    this.pos = 4;
  }

  get offset(): number {
    return this.pos;
  }

  get eof(): boolean {
    return this.pos >= this.buf.length;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  /** Current cipher state — equals the checksum a block must end on. */
  get cipherState(): number {
    return this.state >>> 0;
  }

  mark(): ReaderMark {
    return { offset: this.pos, state: this.state };
  }

  reset(mark: ReaderMark): void {
    this.pos = mark.offset;
    this.state = mark.state;
  }

  private need(n: number): void {
    if (this.pos + n > this.buf.length) throw new TruncatedError(this.pos, n, this.buf.length);
  }

  /** Advance the cipher state over one ciphertext byte. */
  private advance(cipherByte: number): void {
    this.state = (this.state ^ this.table[cipherByte]!) >>> 0;
  }

  readByte(): number {
    this.need(1);
    const c = this.buf[this.pos]!;
    const plain = (c ^ (this.state & 0xff)) & 0xff;
    this.pos += 1;
    this.advance(c);
    return plain;
  }

  readBool(): boolean {
    return this.readByte() !== 0;
  }

  readU32(): number {
    this.need(4);
    const c = this.buf.readUInt32LE(this.pos);
    const plain = (c ^ this.state) >>> 0;
    for (let i = 0; i < 4; i++) this.advance(this.buf[this.pos + i]!);
    this.pos += 4;
    return plain;
  }

  readI32(): number {
    return this.readU32() | 0;
  }

  readFloat(): number {
    const bits = this.readU32();
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, bits, true);
    return view.getFloat32(0, true);
  }

  /**
   * A u32 deciphered against the current state but consumed *without* advancing
   * it. Block lengths are written this way, and the transfer stash header has
   * one more such word right after its version field.
   */
  readU32NoAdvance(): number {
    this.need(4);
    const c = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return (c ^ this.state) >>> 0;
  }

  /** Raw (still-encrypted) u32, consumed without advancing — used for checksums. */
  private readRawU32(): number {
    this.need(4);
    const raw = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return raw >>> 0;
  }

  /** ASCII string: u32 length then that many bytes. */
  readStr(): string {
    const len = this.readU32();
    if (len > this.remaining) throw new TruncatedError(this.pos, len, this.buf.length);
    const bytes = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) bytes[i] = this.readByte();
    return bytes.toString('latin1');
  }

  /** UTF-16LE string: u32 length in *characters*, then 2×length bytes. */
  readWStr(): string {
    const len = this.readU32();
    if (len * 2 > this.remaining) throw new TruncatedError(this.pos, len * 2, this.buf.length);
    const bytes = Buffer.allocUnsafe(len * 2);
    for (let i = 0; i < len * 2; i++) bytes[i] = this.readByte();
    return bytes.toString('utf16le');
  }

  /**
   * Read a block header. The id advances the cipher state; the length is read
   * XOR-state but does *not* advance it (so the state at the end of the body
   * equals the trailing checksum).
   */
  beginBlock(): BlockStart {
    const id = this.readU32();
    const length = this.readU32NoAdvance();
    const bodyStart = this.pos;
    return { id, length, bodyStart, bodyEnd: bodyStart + length };
  }

  /**
   * Consume the trailing checksum word and verify it equals the cipher state.
   * Must be called with the reader positioned exactly at `block.bodyEnd`.
   */
  endBlock(block: BlockStart): void {
    if (this.pos !== block.bodyEnd) {
      throw new Error(
        `block ${block.id}: body consumed ${this.pos - block.bodyStart} of ${block.length} bytes`,
      );
    }
    const expected = this.readRawU32();
    const actual = this.cipherState;
    if (expected !== actual) {
      throw new ChecksumError(block.id, expected, actual, this.pos - 4);
    }
  }

  /** Advance the cipher over `length` body bytes without decoding them. */
  skipBlockBody(length: number): void {
    this.need(length);
    for (let i = 0; i < length; i++) this.advance(this.buf[this.pos + i]!);
    this.pos += length;
  }

  /**
   * Skip an unknown block entirely and resynchronize the cipher.
   *
   * A blind `skipBlockBody` is *not* enough: blocks may contain nested blocks,
   * whose length and checksum words are read without advancing the state, so
   * advancing over them desynchronizes everything that follows. The fix is
   * exact rather than heuristic — a block's trailing checksum word is by
   * definition the writer's cipher state at the end of that block, so adopting
   * it as our state resynchronizes perfectly no matter what the body contained.
   * This is what makes unknown blocks safely skippable (forward compat with
   * future game patches).
   */
  skipBlockAndResync(block: BlockStart): void {
    this.pos = block.bodyEnd;
    this.need(4);
    this.state = this.buf.readUInt32LE(this.pos) >>> 0;
    this.pos += 4;
  }

  /**
   * Decrypt `length` bytes starting at the current position without consuming
   * them (state and offset are restored). For format archaeology / debugging.
   */
  peekPlain(length: number): Buffer {
    const mark = this.mark();
    const out = Buffer.allocUnsafe(Math.min(length, this.remaining));
    for (let i = 0; i < out.length; i++) out[i] = this.readByte();
    this.reset(mark);
    return out;
  }

  /**
   * A standalone trailing checksum, as used by the file header (which is not a
   * length-framed block but still ends on a state-matching word).
   */
  verifyChecksum(label = -1): void {
    const expected = this.readRawU32();
    const actual = this.cipherState;
    if (expected !== actual) throw new ChecksumError(label, expected, actual, this.pos - 4);
  }
}
