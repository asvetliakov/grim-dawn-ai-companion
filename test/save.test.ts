import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { ChecksumError, GdReader } from '../src/core/save/cipher.js';
import { GDC_MAGIC, parseGdc } from '../src/core/save/gdc.js';
import { factionTier } from '../src/core/save/factions.js';
import { GdWriter, synthBlock } from './gdwriter.js';
import {
  CHARACTERS,
  MISSING_SAVES_MESSAGE,
  characterSavePath,
  haveSaves,
  snapshotCharacterSave,
} from './paths.js';

// ---------------------------------------------------------------------------
// Synthetic buffers — these exercise the cipher and block framing without
// needing the game installed.
// ---------------------------------------------------------------------------

describe('GdReader cipher', () => {
  it('derives the key stream from the seed and round-trips values', () => {
    const w = new GdWriter(0x12345678);
    w.writeU32(GDC_MAGIC);
    w.writeStr('records/items/test.dbr');
    w.writeByte(0x2a);
    w.writeU32(0xffffffff);

    const r = new GdReader(w.toBuffer());
    expect(r.readU32()).toBe(GDC_MAGIC);
    expect(r.readStr()).toBe('records/items/test.dbr');
    expect(r.readByte()).toBe(0x2a);
    expect(r.readU32()).toBe(0xffffffff);
  });

  it('advances state over ciphertext, so a byte read and a word read agree on position', () => {
    // Reading 4 bytes individually must leave the cipher in the same state as
    // reading one u32 — the state depends on the ciphertext bytes, not on how
    // the reader groups them. Block skipping relies on this.
    const w = new GdWriter(0xabcdef01);
    w.writeU32(0x11223344);
    w.writeU32(0x55667788);

    const wordwise = new GdReader(w.toBuffer());
    wordwise.readU32();
    const bytewise = new GdReader(w.toBuffer());
    for (let i = 0; i < 4; i++) bytewise.readByte();

    expect(bytewise.offset).toBe(wordwise.offset);
    expect(bytewise.cipherState).toBe(wordwise.cipherState);
    expect(bytewise.readU32()).toBe(0x55667788);
  });
});

describe('block framing', () => {
  it('round-trips a block and verifies its checksum', () => {
    const w = new GdWriter(0x1);
    synthBlock(w, 7, [1, 2, 3]);

    const r = new GdReader(w.toBuffer());
    const block = r.beginBlock();
    expect(block.id).toBe(7);
    expect(block.length).toBe(12);
    expect([r.readU32(), r.readU32(), r.readU32()]).toEqual([1, 2, 3]);
    expect(() => r.endBlock(block)).not.toThrow();
    expect(r.eof).toBe(true);
  });

  it('skips a block body without decoding it', () => {
    const w = new GdWriter(0x99);
    synthBlock(w, 3, [10, 20, 30]);
    synthBlock(w, 4, [40]);

    const r = new GdReader(w.toBuffer());
    const first = r.beginBlock();
    r.skipBlockBody(first.length);
    r.endBlock(first);

    const second = r.beginBlock();
    expect(second.id).toBe(4);
    expect(r.readU32()).toBe(40);
    expect(() => r.endBlock(second)).not.toThrow();
  });

  it('throws ChecksumError when the trailing word disagrees with the state', () => {
    const w = new GdWriter(0x5);
    synthBlock(w, 2, [1, 2], /* corrupt */ true);

    const r = new GdReader(w.toBuffer());
    const block = r.beginBlock();
    r.skipBlockBody(block.length);
    expect(() => r.endBlock(block)).toThrow(ChecksumError);
  });

  it('resyncs from the checksum, so a block containing nested blocks stays skippable', () => {
    // A nested block's length and checksum words do not advance the outer
    // cipher state, so blind-skipping an unknown block desynchronizes it.
    // Adopting the trailing checksum as the state repairs that exactly.
    const w = new GdWriter(0x777);
    w.writeU32(99); // outer id
    // outer body = one nested block (id 0, one word) = 4 + 4 + 4 + 4 bytes
    w.writeLengthNoAdvance(16);
    w.writeU32(0); // nested id
    w.writeLengthNoAdvance(4); // nested length — no advance
    w.writeU32(0xcafe); // nested body
    w.writeChecksum(); // nested checksum — no advance
    w.writeChecksum(); // outer checksum
    synthBlock(w, 5, [0xbeef]); // a block after it, to prove we resynced

    const r = new GdReader(w.toBuffer());
    const outer = r.beginBlock();
    expect(outer.id).toBe(99);

    // Blind skip desynchronizes: it advances over the nested framing words.
    const mark = r.mark();
    r.skipBlockBody(outer.length);
    expect(() => r.endBlock(outer)).toThrow(ChecksumError);

    // Resyncing from the checksum recovers, and the next block reads cleanly.
    r.reset(mark);
    r.skipBlockAndResync(outer);
    const next = r.beginBlock();
    expect(next.id).toBe(5);
    expect(r.readU32()).toBe(0xbeef);
    expect(() => r.endBlock(next)).not.toThrow();
  });
});

describe('faction tiers', () => {
  it('maps reputation values to vendor market tiers', () => {
    expect(factionTier(-5000)).toBe('Hostile');
    expect(factionTier(0)).toBe('Neutral');
    expect(factionTier(1500)).toBe('Neutral');
    expect(factionTier(1501)).toBe('Friendly');
    expect(factionTier(5001)).toBe('Respected');
    expect(factionTier(10001)).toBe('Honored');
    expect(factionTier(24999)).toBe('Honored');
    expect(factionTier(25000)).toBe('Revered');
  });
});

describe.skipIf(!haveSaves())('live player.gdc saves', () => {
  if (!haveSaves()) {
    it.skip(MISSING_SAVES_MESSAGE, () => {});
  }

  it.each(CHARACTERS)('parses %s with every block checksum passing', (character) => {
    const save = parseGdc(readFileSync(characterSavePath(character)));

    // The gate for this parser: a passing checksum on every block — parsed and
    // skipped alike — is proof we consumed the file byte-for-byte correctly.
    const unverified = save.blocks.filter((b) => !b.checksumOk);
    expect(unverified, `blocks failing checksum: ${JSON.stringify(unverified)}`).toEqual([]);
    expect(save.warnings).toEqual([]);
    expect(save.blocks.length).toBeGreaterThan(10);

    // Every block is decoded, and that is a requirement rather than a nicety:
    // a block whose field widths are unknown cannot be re-enciphered, so a
    // single skipped block would make the save unwritable (see transcript.ts).
    const skipped = save.blocks.filter((b) => b.status !== 'parsed').map((b) => b.id);
    expect(skipped, 'blocks that fell back to a blind skip').toEqual([]);
    const decoded = save.blocks.filter((b) => b.status === 'parsed').map((b) => b.id).sort((a, b) => a - b);
    expect(decoded).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 13, 14, 15, 16, 17]);
  });

  it.each(CHARACTERS)('reads coherent character data for %s', (character) => {
    const save = parseGdc(readFileSync(characterSavePath(character)));

    expect(save.name).toBe(character.replace(/^_/, ''));
    expect(save.level).toBeGreaterThan(0);
    // The header level and the bio block's level are written independently.
    expect(save.attributes.level).toBe(save.level);
    expect(save.classRecord).toMatch(/^tagSkillClassName/);
    expect(save.attributes.physique).toBeGreaterThan(0);
    expect(save.attributes.health).toBeGreaterThan(0);
    expect(save.factions.length).toBeGreaterThan(20);
    expect(save.skills.length).toBeGreaterThan(0);
    expect(save.equipment).toHaveLength(12);
    expect(save.weaponSet1).toHaveLength(2);

    // Every item that exists must carry a DBR record path — that is what
    // Stage 3 resolves against the game database.
    const allItems = [
      ...save.equipment.filter((i) => i !== null),
      ...save.inventorySacks.flat(),
      ...save.personalStash.flatMap((t) => t.items),
    ];
    for (const item of allItems) {
      expect(item.baseName).toMatch(/^records\/.*\.dbr$/);
      expect(item.stackCount).toBeGreaterThanOrEqual(1);
    }
  });

  it('reads the expected gear and progression for the primary fixture', () => {
    // Snapshot-copied so playing the character does not break these assertions.
    const save = parseGdc(readFileSync(snapshotCharacterSave('_Suchka')));

    expect(save.name).toBe('Suchka');
    expect(save.hardcore).toBe(false);
    expect(save.difficulty).toBe('Ultimate');
    expect(save.iron).toBeGreaterThan(0);
    expect(save.masteriesAllowed).toBe(2);

    // A fully-geared character: all 12 slots filled, and the slot mapping is
    // confirmed by each record living under its slot's item category.
    expect(save.equipment.every((e) => e !== null)).toBe(true);
    expect(save.equipment[0]!.baseName).toContain('gearhead/');
    expect(save.equipment[2]!.baseName).toContain('geartorso/');
    expect(save.equipment[9]!.baseName).toContain('gearshoulders/');
    expect(save.equipment[10]!.baseName).toContain('medals/');
    expect(save.equipment[11]!.baseName).toContain('gearrelic/');

    // Weapons live in the alternate weapon sets, not the equipment array.
    expect(save.weaponSet1[0]?.baseName).toContain('gearweapons/');

    // Inventory sacks use i32 coordinates; the personal stash uses floats.
    // Both must land on sane grid positions rather than garbage.
    for (const item of save.inventorySacks.flat()) {
      expect(Number.isInteger(item.x)).toBe(true);
      expect(item.x).toBeGreaterThanOrEqual(0);
      expect(item.x).toBeLessThan(64);
    }
    for (const tab of save.personalStash) {
      expect(tab.width).toBeGreaterThan(0);
      expect(tab.height).toBeGreaterThan(0);
      for (const item of tab.items) {
        expect(item.x).toBeGreaterThanOrEqual(0);
        expect(item.x).toBeLessThan(tab.width);
        expect(item.y).toBeLessThan(tab.height);
      }
    }
  });

  it('rejects a file that is not a character save', () => {
    const buf = Buffer.alloc(64);
    buf.writeUInt32LE(0x55555555, 0); // seed 0 — magic decodes to 0, not GDCX
    expect(() => parseGdc(buf)).toThrow(/not a Grim Dawn character save/);
  });
});
