/**
 * The encoder side of the save cipher — the mirror image of `GdReader`.
 *
 * State advances over ciphertext, length words are enciphered without advancing
 * it, and a block's trailing checksum is the raw state at that point. This
 * started life as a test helper (`test/gdwriter.ts`, which now re-exports it);
 * it became production code when the tool learned to write a save back.
 *
 * Nothing here decides *what* to write — see `transcript.ts` for the replay that
 * makes an edit safe.
 */

/** Handle returned by `beginBlock`, so `endBlock` can back-patch the length. */
export interface WriterBlock {
  /** Index in the output of the (not yet written) length word. */
  readonly lengthAt: number;
  /** Cipher state the length word must be enciphered against. */
  readonly lengthState: number;
  /** Index of the first body byte. */
  readonly bodyStart: number;
}

export class GdWriter {
  private readonly out: number[] = [];
  private readonly table: Uint32Array;
  private state: number;

  constructor(readonly seed: number) {
    this.table = new Uint32Array(256);
    let v = seed >>> 0;
    for (let i = 0; i < 256; i++) {
      v = ((v << 31) | (v >>> 1)) >>> 0;
      v = Math.imul(v, 39916801) >>> 0;
      this.table[i] = v;
    }
    this.state = seed >>> 0;
    // The file starts with the seed, obfuscated but not enciphered.
    const head = Buffer.alloc(4);
    head.writeUInt32LE((seed ^ 0x55555555) >>> 0, 0);
    this.out.push(...head);
  }

  /** Current cipher state — what a checksum written here would carry. */
  get cipherState(): number {
    return this.state >>> 0;
  }

  get length(): number {
    return this.out.length;
  }

  private advance(cipherByte: number): void {
    this.state = (this.state ^ this.table[cipherByte]!) >>> 0;
  }

  writeByte(plain: number): void {
    const c = (plain ^ (this.state & 0xff)) & 0xff;
    this.out.push(c);
    this.advance(c);
  }

  writeBool(value: boolean): void {
    this.writeByte(value ? 1 : 0);
  }

  writeU32(plain: number): void {
    const c = ((plain >>> 0) ^ this.state) >>> 0;
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(c, 0);
    for (const b of buf) {
      this.out.push(b);
      this.advance(b);
    }
  }

  writeI32(value: number): void {
    this.writeU32(value >>> 0);
  }

  writeFloat(value: number): void {
    const buf = Buffer.alloc(4);
    buf.writeFloatLE(value, 0);
    this.writeU32(buf.readUInt32LE(0));
  }

  /** ASCII string: u32 length then that many bytes. */
  writeStr(s: string): void {
    this.writeU32(s.length);
    for (let i = 0; i < s.length; i++) this.writeByte(s.charCodeAt(i) & 0xff);
  }

  /** UTF-16LE string: u32 length in *characters*, then 2×length bytes. */
  writeWStr(s: string): void {
    const bytes = Buffer.from(s, 'utf16le');
    this.writeU32(bytes.length / 2);
    for (const b of bytes) this.writeByte(b);
  }

  /** A word enciphered against the current state that does not advance it. */
  writeU32NoAdvance(plain: number): void {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(((plain >>> 0) ^ this.state) >>> 0, 0);
    this.out.push(...buf);
  }

  /** Alias that reads better at a block header. */
  writeLengthNoAdvance(plain: number): void {
    this.writeU32NoAdvance(plain);
  }

  /** The trailing checksum is the raw current state, written verbatim. */
  writeChecksum(corrupt = false): void {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(corrupt ? (this.state ^ 0xdeadbeef) >>> 0 : this.state, 0);
    this.out.push(...buf);
  }

  /**
   * Open a block whose length is not known yet: reserve the length word and
   * remember the state it has to be enciphered against (it does not advance the
   * state, so back-patching it later is exact).
   */
  beginBlock(id: number): WriterBlock {
    this.writeU32(id);
    const lengthAt = this.out.length;
    const lengthState = this.state;
    this.out.push(0, 0, 0, 0);
    return { lengthAt, lengthState, bodyStart: this.out.length };
  }

  endBlock(block: WriterBlock, corrupt = false): void {
    const length = this.out.length - block.bodyStart;
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(((length >>> 0) ^ block.lengthState) >>> 0, 0);
    for (let i = 0; i < 4; i++) this.out[block.lengthAt + i] = buf[i]!;
    this.writeChecksum(corrupt);
  }

  /**
   * Copy ciphertext through untouched and adopt the state it ends on.
   *
   * Only sound while the stream is still byte-identical to the file this came
   * from — the ciphertext carries its own keystream, so a region copied after an
   * upstream edit would decode to garbage. `replay` is what enforces that.
   */
  writeRawCipher(cipher: Buffer, endState: number): void {
    for (const b of cipher) this.out.push(b);
    this.state = endState >>> 0;
  }

  /** Raw bytes with no state change at all — the unconsumed file tail. */
  writeTail(bytes: Buffer): void {
    for (const b of bytes) this.out.push(b);
  }

  toBuffer(): Buffer {
    return Buffer.from(this.out);
  }
}
