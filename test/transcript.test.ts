import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { GdReader } from '../src/core/save/cipher.js';
import { parseGdc, parseGdcRecording } from '../src/core/save/gdc.js';
import {
  OpaqueRegionError,
  PrefixMismatchError,
  SegWriter,
  TranscriptRecorder,
  opaqueBlocks,
  replay,
  spliceRegion,
  type Seg,
  type Transcript,
} from '../src/core/save/transcript.js';
import { GdWriter } from '../src/core/save/writer.js';
import { CHARACTERS, MISSING_SAVES_MESSAGE, characterSavePath, haveSaves } from './paths.js';

// ---------------------------------------------------------------------------
// The fact the whole module is built around
// ---------------------------------------------------------------------------

describe('why widths matter', () => {
  it('a region captured bytewise decodes to garbage once anything upstream changes', () => {
    // This is the reason `u8` and `opaque` are different segment kinds, and it
    // is worth failing loudly over: the checksum cannot see this mistake, and
    // neither can a no-op round trip. `readU32` xors the whole 32-bit state;
    // four `readByte`s xor `state & 0xff` and advance in between.
    const build = (marker: number): Buffer => {
      const w = new GdWriter(0x1234);
      w.writeU32(marker);
      w.writeU32(0xdeadbeef);
      return w.toBuffer();
    };
    const original = build(0xaaaaaaaa);

    const reader = new GdReader(original);
    reader.readU32();
    const captured = [reader.readByte(), reader.readByte(), reader.readByte(), reader.readByte()];

    const replayed = (marker: number): Buffer => {
      const w = new GdWriter(0x1234);
      w.writeU32(marker);
      for (const b of captured) w.writeByte(b);
      return w.toBuffer();
    };

    // Same state: byte-identical, and the payload still reads back.
    const untouched = replayed(0xaaaaaaaa);
    expect(untouched.equals(original)).toBe(true);
    const ok = new GdReader(untouched);
    ok.readU32();
    expect(ok.readU32()).toBe(0xdeadbeef);

    // One word changed upstream, and the payload is now noise — silently.
    const edited = replayed(0xbbbbbbbb);
    const bad = new GdReader(edited);
    expect(bad.readU32()).toBe(0xbbbbbbbb);
    expect(bad.readU32()).not.toBe(0xdeadbeef);
  });
});

// ---------------------------------------------------------------------------
// Synthetic transcripts
// ---------------------------------------------------------------------------

/** A file with a header checksum, a nested block, and a quirk word. */
function synthFile(seed = 0x99): Buffer {
  const w = new GdWriter(seed);
  w.writeU32(0x58434447);
  w.writeWStr('Sûchka');
  w.writeBool(true);
  w.writeChecksum();

  const outer = w.beginBlock(3);
  w.writeU32(11);
  w.writeU32NoAdvance(42); // the .gst-style quirk word
  const inner = w.beginBlock(0);
  w.writeStr('records/items/a.dbr');
  w.writeFloat(1.5);
  w.endBlock(inner);
  w.endBlock(outer);

  const tail = w.beginBlock(9);
  w.writeU32(7);
  w.endBlock(tail);
  return w.toBuffer();
}

/**
 * Walk `synthFile` with a recorder attached, exactly as a parser would.
 *
 * `opaqueTail` blind-skips the flat trailing block, which is what happens to an
 * unknown block id. The nested one cannot be skipped that way — its inner
 * length word does not advance the cipher, so a blind walk desynchronizes,
 * which is the whole reason `skipBlockAndResync` exists.
 */
function recordSynth(buf: Buffer, opaqueTail = false): Transcript {
  const rec = new TranscriptRecorder();
  const r = new GdReader(buf, rec);
  r.readU32();
  r.readWStr();
  r.readBool();
  r.verifyChecksum(0);

  const outer = r.beginBlock();
  r.readU32();
  r.readU32NoAdvance();
  const inner = r.beginBlock();
  r.readStr();
  r.readFloat();
  r.endBlock(inner);
  r.endBlock(outer);

  const tail = r.beginBlock();
  if (opaqueTail) r.skipBlockBody(tail.length, tail.id);
  else r.readU32();
  r.endBlock(tail);
  return rec.finish(r.seed, Buffer.from(r.restOfFile()));
}

describe('transcript round trip', () => {
  it('replays a recorded file byte for byte', () => {
    const buf = synthFile();
    expect(replay(recordSynth(buf)).equals(buf)).toBe(true);
  });

  it('re-enciphers correctly under a different seed', () => {
    // The only test that exercises a total state shift, and so the only one
    // that proves the widths are right rather than merely self-consistent.
    const buf = synthFile();
    const t = recordSynth(buf);
    const reseeded = replay({ ...t, seed: (t.seed ^ 0xffffffff) >>> 0 });
    expect(reseeded.equals(buf)).toBe(false);

    const r = new GdReader(reseeded);
    expect(r.readU32()).toBe(0x58434447);
    expect(r.readWStr()).toBe('Sûchka');
    expect(r.readBool()).toBe(true);
    expect(() => r.verifyChecksum(0)).not.toThrow();
    const outer = r.beginBlock();
    expect(outer.id).toBe(3);
    expect(r.readU32()).toBe(11);
    expect(r.readU32NoAdvance()).toBe(42);
    const inner = r.beginBlock();
    expect(r.readStr()).toBe('records/items/a.dbr');
    expect(r.readFloat()).toBe(1.5);
    expect(() => r.endBlock(inner)).not.toThrow();
    expect(() => r.endBlock(outer)).not.toThrow();
  });

  it('recomputes a block length when the edited body changes size', () => {
    const buf = synthFile();
    const t = recordSynth(buf);
    const segments = t.segments.map((seg) => {
      if (seg.kind !== 'block' || seg.id !== 9) return seg;
      return { kind: 'block' as const, id: 9, body: [{ kind: 'u32' as const, value: 7, edited: true as const }, { kind: 'u32' as const, value: 8, edited: true as const }] };
    });
    const out = replay({ ...t, segments });

    const r = new GdReader(out);
    r.readU32();
    r.readWStr();
    r.readBool();
    r.verifyChecksum(0);
    const outer = r.beginBlock();
    r.skipBlockAndResync(outer);
    const tail = r.beginBlock();
    expect(tail.length).toBe(8);
    expect(r.readU32()).toBe(7);
    expect(r.readU32()).toBe(8);
    expect(() => r.endBlock(tail)).not.toThrow();
  });

  it('truncates the transcript when a speculative decode is rewound', () => {
    // What `parseBlock` does on a decoder that disagrees with the file: read
    // part of a block, roll back, then skip it. The transcript must not keep
    // the abandoned reads.
    const buf = synthFile();
    const rec = new TranscriptRecorder();
    const r = new GdReader(buf, rec);
    r.readU32();
    r.readWStr();
    r.readBool();
    r.verifyChecksum(0);

    const outer = r.beginBlock();
    r.readU32();
    r.readU32NoAdvance();
    const inner = r.beginBlock();
    r.readStr();
    r.readFloat();
    r.endBlock(inner);
    r.endBlock(outer);

    const tail = r.beginBlock();
    const mark = r.mark();
    r.readByte(); // a decoder that has the width wrong
    r.readByte();
    r.reset(mark); // …and is rolled back
    r.readU32();
    r.endBlock(tail);

    const t = rec.finish(r.seed, Buffer.from(r.restOfFile()));
    expect(opaqueBlocks(t)).toEqual([]);
    expect(replay(t).equals(buf)).toBe(true);
    // The abandoned byte reads are gone, not left as a stray run.
    const tailSeg = t.segments.find((s) => s.kind === 'block' && s.id === 9);
    expect(tailSeg).toMatchObject({ body: [{ kind: 'u32', value: 7 }] });
  });
});

describe('refusing to write what it cannot rebuild', () => {
  it('replays an opaque region that nothing upstream has changed', () => {
    const buf = synthFile();
    expect(replay(recordSynth(buf, true)).equals(buf)).toBe(true);
  });

  it('throws when an opaque region follows an edit, naming the block', () => {
    const t = recordSynth(synthFile(), true);
    const segments = t.segments.map((seg) =>
      seg.kind === 'checksum' ? seg : seg.kind === 'u8' ? { ...seg, edited: true as const } : seg,
    );
    expect(() => replay({ ...t, segments })).toThrow(OpaqueRegionError);
    try {
      replay({ ...t, segments });
    } catch (err) {
      expect((err as OpaqueRegionError).blockId).toBe(9);
    }
  });
});

describe('spliceRegion', () => {
  const region = (): Seg[] => {
    const w = new SegWriter();
    w.u32(5);
    w.str('abc');
    w.bool(true);
    return w.segments();
  };

  it('substitutes an encoding that matches the file', () => {
    const before = region();
    const w = new SegWriter();
    w.u32(5);
    w.str('abcd');
    w.bool(true);
    const out = spliceRegion(region(), before, w.segments(), 'test');
    expect(out.every((s) => 'edited' in s && s.edited)).toBe(true);
    expect(out[1]).toMatchObject({ kind: 'u32', value: 4 });
  });

  it('keeps whatever the encoder does not model', () => {
    const orig = [...region(), { kind: 'u32' as const, value: 999 }];
    const out = spliceRegion(orig, region(), region(), 'test');
    expect(out[out.length - 1]).toEqual({ kind: 'u32', value: 999 });
  });

  it('refuses when the encoder disagrees with the file', () => {
    const w = new SegWriter();
    w.u32(6); // the file says 5
    w.str('abc');
    w.bool(true);
    expect(() => spliceRegion(region(), w.segments(), w.segments(), 'test')).toThrow(PrefixMismatchError);
  });
});

// ---------------------------------------------------------------------------
// The live saves
// ---------------------------------------------------------------------------

describe.skipIf(!haveSaves())('live player.gdc transcripts', () => {
  if (!haveSaves()) {
    it.skip(MISSING_SAVES_MESSAGE, () => {});
  }

  it.each(CHARACTERS)('replays %s byte for byte, with nothing left opaque', (character) => {
    const source = readFileSync(characterSavePath(character));
    const { transcript } = parseGdcRecording(source);

    expect(replay(transcript).equals(source)).toBe(true);
    // Any opaque block would make this save unwritable — see transcript.ts.
    expect(opaqueBlocks(transcript)).toEqual([]);
    expect(transcript.resynced).toEqual([]);
    expect(transcript.tail).toHaveLength(0);
  });

  it.each(CHARACTERS)('survives a total state shift for %s', (character) => {
    // Re-encipher under a different seed and re-parse: every field must come
    // back identical. A wrong field width is invisible to the checksum and to a
    // same-seed round trip, and shows up here.
    const source = readFileSync(characterSavePath(character));
    const { save, transcript } = parseGdcRecording(source);
    const reseeded = replay({ ...transcript, seed: (transcript.seed ^ 0xffffffff) >>> 0 });

    expect(reseeded.equals(source)).toBe(false);
    expect(reseeded).toHaveLength(source.length);

    const after = parseGdc(reseeded);
    expect(after.warnings).toEqual([]);
    expect(after.blocks.filter((b) => !b.checksumOk || b.status !== 'parsed')).toEqual([]);
    expect(after).toEqual(save);
  });
});
