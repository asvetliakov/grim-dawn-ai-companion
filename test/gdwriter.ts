/**
 * The encoder side of the save cipher — tests only.
 *
 * Having a writer lets us build synthetic saves whose framing we control, so a
 * failure points at the reader rather than at a guess about the real format.
 * It is the mirror image of `GdReader`: state advances over ciphertext, length
 * words are enciphered without advancing, and a block's trailing checksum is
 * the raw state at that point.
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

  private advance(cipherByte: number): void {
    this.state = (this.state ^ this.table[cipherByte]!) >>> 0;
  }

  writeByte(plain: number): void {
    const c = (plain ^ (this.state & 0xff)) & 0xff;
    this.out.push(c);
    this.advance(c);
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

  writeFloat(value: number): void {
    const buf = Buffer.alloc(4);
    buf.writeFloatLE(value, 0);
    this.writeU32(buf.readUInt32LE(0));
  }

  writeStr(s: string): void {
    this.writeU32(s.length);
    for (let i = 0; i < s.length; i++) this.writeByte(s.charCodeAt(i));
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

  toBuffer(): Buffer {
    return Buffer.from(this.out);
  }
}

/** A fixed-payload block: id, length, body of `payload` words, trailing checksum. */
export function synthBlock(w: GdWriter, id: number, payload: number[], corrupt = false): void {
  w.writeU32(id);
  w.writeLengthNoAdvance(payload.length * 4);
  for (const v of payload) w.writeU32(v);
  w.writeChecksum(corrupt);
}

/**
 * The 18-field item struct as 1.3.0.6 writes it. Only the fields a test cares
 * about are parameterized; the rest are zero, which is what real saves hold.
 */
export function writeItem(
  w: GdWriter,
  { baseName, stackCount = 1, seed = 0 }: { baseName: string; stackCount?: number; seed?: number },
): void {
  w.writeStr(baseName);
  w.writeStr(''); // prefix
  w.writeStr(''); // suffix
  w.writeStr(''); // modifier
  w.writeStr(''); // transmute
  w.writeU32(seed);
  w.writeStr(''); // relic (component)
  w.writeStr(''); // relic bonus
  w.writeU32(0); // relic seed
  w.writeStr(''); // augment
  w.writeU32(0); // unknown
  w.writeU32(0); // augment seed
  w.writeU32(0); // relic completion level
  w.writeU32(0); // unknownExtra[0]
  w.writeU32(0); // unknownExtra[1]
  w.writeU32(stackCount);
  w.writeU32(0); // unknownExtra[2]
  w.writeU32(0); // unknownExtra[3]
}
