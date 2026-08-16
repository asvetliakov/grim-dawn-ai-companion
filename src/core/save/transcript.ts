/**
 * A record/replay layer over the save cipher — what makes editing a save safe.
 *
 * The cipher state advances over *ciphertext*, so changing one byte re-enciphers
 * everything after it. The trap that shapes this whole module is subtler: the
 * same ciphertext decodes to different plaintext depending on the *width* it is
 * read at. `readU32` xors the whole 32-bit state; four `readByte`s xor
 * `state & 0xff` and advance in between. So a region captured bytewise and
 * re-enciphered from a different state still checksums — and every u32, float
 * and string length inside it is silently garbage.
 *
 * Two consequences are baked in here:
 *
 *  - `u8` (bytes a decoder *chose* to read as bytes) and `opaque` (bytes
 *    `skipBlockBody` handed back, true widths unknown) are different segment
 *    kinds and must never be merged. `test/transcript.test.ts` pins the reason.
 *  - `replay` throws `OpaqueRegionError` the moment it meets an `opaque` or
 *    `raw` segment *after* an edit. Corruption becomes a mechanical refusal.
 *
 * A byte-identical no-op round trip is therefore a necessary gate and a
 * misleading one on its own: it passes for a transcript full of opaque regions.
 * The test that means something is the reseed round trip.
 */

import { GdWriter } from './writer.js';

export type Seg =
  /** A run of byte-width reads. Width-known: replays correctly at any state. */
  | { kind: 'u8'; plain: number[]; edited?: true }
  | { kind: 'u32'; value: number; edited?: true }
  /** The length-word trick outside a block header: the .gst quirk word. */
  | { kind: 'noadvance'; value: number; edited?: true }
  /** A length-framed block. Length and trailing checksum recomputed on replay. */
  | { kind: 'block'; id: number; body: Seg[]; edited?: true }
  /** The file header's standalone state word. */
  | { kind: 'checksum'; edited?: true }
  /** Undecoded body bytes — true field widths UNKNOWN. Unwritable after an edit. */
  | { kind: 'opaque'; plain: number[]; blockId: number }
  /** A whole block copied as ciphertext, state adopted from its checksum. */
  | { kind: 'raw'; cipher: Buffer; endState: number; blockId: number };

export interface Transcript {
  readonly seed: number;
  readonly segments: Seg[];
  /** Bytes the reader never consumed (trailing junk after the last block). */
  readonly tail: Buffer;
  /** Block ids that needed `skipBlockAndResync` — see `raw`. */
  readonly resynced: number[];
}

export class OpaqueRegionError extends Error {
  constructor(readonly blockId: number) {
    super(
      `block ${blockId} is not decoded, so it cannot be re-enciphered after an edit ` +
        `(its field widths are unknown; re-encoding it bytewise would corrupt it silently)`,
    );
    this.name = 'OpaqueRegionError';
  }
}

export class PrefixMismatchError extends Error {
  constructor(readonly region: string, readonly index: number, detail: string) {
    super(`${region}: encoder disagrees with the file at segment ${index} (${detail})`);
    this.name = 'PrefixMismatchError';
  }
}

// ---------------------------------------------------------------------------
// Building segments
// ---------------------------------------------------------------------------

/**
 * Emits the same segment shapes the recorder produces, so an encoder written as
 * the mirror of a decoder compares equal to what was read. Byte writes coalesce
 * into one `u8` run exactly as they do on the way in.
 */
export class SegWriter {
  protected stack: Seg[][] = [[]];
  protected pendingIds: number[] = [];

  protected get top(): Seg[] {
    return this.stack[this.stack.length - 1]!;
  }

  u8(plain: number): void {
    const last = this.top[this.top.length - 1];
    if (last?.kind === 'u8') last.plain.push(plain & 0xff);
    else this.top.push({ kind: 'u8', plain: [plain & 0xff] });
  }

  bool(value: boolean): void {
    this.u8(value ? 1 : 0);
  }

  u32(value: number): void {
    this.top.push({ kind: 'u32', value: value >>> 0 });
  }

  i32(value: number): void {
    this.u32(value >>> 0);
  }

  f32(value: number): void {
    const buf = Buffer.alloc(4);
    buf.writeFloatLE(value, 0);
    this.u32(buf.readUInt32LE(0));
  }

  str(s: string): void {
    this.u32(s.length);
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
  }

  wstr(s: string): void {
    const bytes = Buffer.from(s, 'utf16le');
    this.u32(bytes.length / 2);
    for (const b of bytes) this.u8(b);
  }

  noadvance(value: number): void {
    this.top.push({ kind: 'noadvance', value: value >>> 0 });
  }

  checksum(): void {
    this.top.push({ kind: 'checksum' });
  }

  beginBlock(id: number): void {
    this.stack.push([]);
    // The node itself is appended on endBlock, once its body is complete.
    this.pendingIds.push(id);
  }

  endBlock(): void {
    const body = this.stack.pop()!;
    const id = this.pendingIds.pop()!;
    this.top.push({ kind: 'block', id, body });
  }

  /** The segments built so far (the outermost frame). */
  segments(): Seg[] {
    if (this.stack.length !== 1) throw new Error('SegWriter: unclosed block');
    return this.stack[0]!;
  }
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export interface RecorderMark {
  readonly depth: number;
  readonly length: number;
  /** Length of the trailing `u8` run at mark time, or -1 if there wasn't one. */
  readonly run: number;
}

/**
 * Attached to a `GdReader`; every primitive read appends to the transcript.
 * `mark`/`reset` truncate it, which is what keeps `parseBlock`'s speculative
 * decode-then-roll-back honest.
 */
export class TranscriptRecorder extends SegWriter {
  readonly resynced: number[] = [];

  opaque(blockId: number, plain: number[]): void {
    this.top.push({ kind: 'opaque', plain, blockId });
  }

  /** A block that had to be resynced from its checksum: keep it as ciphertext. */
  rawBlock(blockId: number, cipher: Buffer, endState: number): void {
    // The open frame holds whatever the failed attempts recorded; drop it.
    this.stack.pop();
    this.pendingIds.pop();
    this.resynced.push(blockId);
    this.top.push({ kind: 'raw', cipher, endState, blockId });
  }

  mark(): RecorderMark {
    const last = this.top[this.top.length - 1];
    return {
      depth: this.stack.length,
      length: this.top.length,
      run: last?.kind === 'u8' ? last.plain.length : -1,
    };
  }

  reset(m: RecorderMark): void {
    while (this.stack.length > m.depth) {
      this.stack.pop();
      this.pendingIds.pop();
    }
    this.top.length = m.length;
    if (m.run >= 0) {
      const last = this.top[this.top.length - 1];
      if (last?.kind === 'u8') last.plain.length = m.run;
    }
  }

  finish(seed: number, tail: Buffer): Transcript {
    return { seed, segments: this.segments(), tail, resynced: [...this.resynced] };
  }
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/**
 * Re-encipher a transcript into a file. Lengths and checksums are recomputed
 * from the new cipher state, so an edited body of a different size is fine.
 *
 * Throws `OpaqueRegionError` if an undecoded region would have to be written
 * after the stream has diverged from the file it came from.
 */
export function replay(t: Transcript): Buffer {
  const w = new GdWriter(t.seed);
  let diverged = false;

  const walk = (segs: Seg[]): void => {
    for (const seg of segs) {
      if ('edited' in seg && seg.edited) diverged = true;
      switch (seg.kind) {
        case 'u8':
          for (const b of seg.plain) w.writeByte(b);
          break;
        case 'u32':
          w.writeU32(seg.value);
          break;
        case 'noadvance':
          w.writeU32NoAdvance(seg.value);
          break;
        case 'checksum':
          w.writeChecksum();
          break;
        case 'block': {
          const block = w.beginBlock(seg.id);
          walk(seg.body);
          w.endBlock(block);
          break;
        }
        case 'opaque':
          if (diverged) throw new OpaqueRegionError(seg.blockId);
          for (const b of seg.plain) w.writeByte(b);
          break;
        case 'raw':
          if (diverged) throw new OpaqueRegionError(seg.blockId);
          w.writeRawCipher(seg.cipher, seg.endState);
          break;
      }
    }
  };

  walk(t.segments);
  w.writeTail(t.tail);
  return w.toBuffer();
}

/** Block ids whose bodies are still undecoded, in transcript order. */
export function opaqueBlocks(t: Transcript): number[] {
  const out: number[] = [];
  const walk = (segs: Seg[]): void => {
    for (const seg of segs) {
      if (seg.kind === 'opaque' || seg.kind === 'raw') out.push(seg.blockId);
      else if (seg.kind === 'block') walk(seg.body);
    }
  };
  walk(t.segments);
  return out;
}

// ---------------------------------------------------------------------------
// Splicing an edit in
// ---------------------------------------------------------------------------

function describe(seg: Seg | undefined): string {
  if (!seg) return 'nothing';
  switch (seg.kind) {
    case 'u8':
      return `${seg.plain.length} byte(s)`;
    case 'u32':
      return `u32 ${seg.value}`;
    case 'noadvance':
      return `noadvance ${seg.value}`;
    case 'block':
      return `block ${seg.id}`;
    case 'checksum':
      return 'checksum';
    case 'opaque':
      return `opaque(${seg.blockId})`;
    case 'raw':
      return `raw(${seg.blockId})`;
  }
}

function sameSeg(a: Seg, b: Seg): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'u8' && b.kind === 'u8') {
    return a.plain.length === b.plain.length && a.plain.every((v, i) => v === b.plain[i]);
  }
  if (a.kind === 'u32' && b.kind === 'u32') return a.value === b.value;
  if (a.kind === 'noadvance' && b.kind === 'noadvance') return a.value === b.value;
  if (a.kind === 'checksum') return true;
  if (a.kind === 'block' && b.kind === 'block') {
    return a.id === b.id && a.body.length === b.body.length && a.body.every((s, i) => sameSeg(s, b.body[i]!));
  }
  return false;
}

function markEdited(segs: Seg[]): Seg[] {
  return segs.map((seg) => (seg.kind === 'opaque' || seg.kind === 'raw' ? seg : { ...seg, edited: true as const }));
}

/**
 * Replace a region of a recorded body with a re-encoded one.
 *
 * `before` is what the encoder makes of the *unedited* save. Requiring it to be
 * a structural prefix of what was actually read is the real guard on every edit:
 * we prove the encoder reproduces this file field for field before we let it
 * change anything. Whatever the encoder does not model stays as recorded.
 */
export function spliceRegion(orig: Seg[], before: Seg[], after: Seg[], region = 'region'): Seg[] {
  if (before.length > orig.length) {
    throw new PrefixMismatchError(region, orig.length, `encoder emitted ${before.length} segments, file has ${orig.length}`);
  }
  for (let i = 0; i < before.length; i++) {
    if (!sameSeg(before[i]!, orig[i]!)) {
      throw new PrefixMismatchError(region, i, `encoded ${describe(before[i])}, file has ${describe(orig[i])}`);
    }
  }
  return [...markEdited(after), ...orig.slice(before.length)];
}
