import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { GST_MAGIC, parseFormulas, parseFormulasFile, parseTransferStash } from '../src/core/save/gst.js';
import { GdWriter, writeItem } from './gdwriter.js';
import {
  FORMULAS_PATH,
  MISSING_GST_MESSAGE,
  TRANSFER_STASH_PATH,
  haveFormulas,
  haveTransferStash,
  snapshotSharedSave,
} from './paths.js';

const REPO_ROOT = join(import.meta.dirname, '..');

// ---------------------------------------------------------------------------
// transfer.gst — synthetic
// ---------------------------------------------------------------------------

interface SynthItem {
  baseName: string;
  x: number;
  y: number;
  stackCount?: number;
}

/** Build a minimal but structurally faithful transfer.gst in memory. */
function synthStash(sacks: { width: number; height: number; items: SynthItem[] }[], mod = ''): Buffer {
  const w = new GdWriter(0x2b2b2b2b);
  w.writeU32(GST_MAGIC);

  const block = w.beginBlock(18);
  w.writeU32(11); // version
  w.writeU32NoAdvance(0); // the header's non-advancing quirk word
  w.writeStr(mod);
  w.writeByte(7); // expansion status
  w.writeU32(sacks.length);
  for (const sack of sacks) {
    const nested = w.beginBlock(0);
    w.writeU32(sack.width);
    w.writeU32(sack.height);
    w.writeU32(sack.items.length);
    for (const item of sack.items) {
      writeItem(w, { baseName: item.baseName, ...(item.stackCount !== undefined && { stackCount: item.stackCount }) });
      w.writeFloat(item.x);
      w.writeFloat(item.y);
    }
    for (let i = 0; i < 5; i++) w.writeU32(0); // per-sack trailing words
    w.endBlock(nested);
  }
  w.endBlock(block);
  return w.toBuffer();
}

describe('transfer.gst framing', () => {
  it('round-trips sacks, items and the header quirk word', () => {
    const buf = synthStash([
      { width: 10, height: 19, items: [{ baseName: 'records/items/a.dbr', x: 3, y: 4, stackCount: 12 }] },
      { width: 8, height: 16, items: [] },
    ]);

    const stash = parseTransferStash(buf);

    expect(stash.warnings).toEqual([]);
    expect(stash.blocks).toEqual([{ id: 18, length: expect.any(Number), status: 'parsed', checksumOk: true }]);
    expect(stash.version).toBe(11);
    expect(stash.mod).toBe('');
    expect(stash.expansionStatus).toBe(7);
    expect(stash.sacks).toHaveLength(2);
    expect(stash.sacks[0]!.width).toBe(10);
    expect(stash.sacks[0]!.height).toBe(19);
    expect(stash.sacks[1]!.items).toEqual([]);

    const item = stash.sacks[0]!.items[0]!;
    expect(item.baseName).toBe('records/items/a.dbr');
    expect(item.stackCount).toBe(12);
  });

  it('reads stash coordinates as floats, not i32', () => {
    // The classic porting bug: player.gdc's inventory sacks store X/Y as i32
    // while every stash does it as float. Both are 4 bytes, so reading the wrong
    // one desynchronizes nothing — it just silently yields absurd coordinates.
    // 3.0f is 0x40400000, which as an i32 would be 1077936128.
    const buf = synthStash([
      { width: 10, height: 19, items: [{ baseName: 'records/items/a.dbr', x: 3, y: 4.5 }] },
    ]);

    const item = parseTransferStash(buf).sacks[0]!.items[0]!;
    expect(item.x).toBe(3);
    expect(item.y).toBe(4.5); // a fractional value no i32 read could produce
    expect(item.x).not.toBe(0x40400000);
  });

  it('carries the mod name through', () => {
    const stash = parseTransferStash(synthStash([], 'GrimmestDawn'));
    expect(stash.mod).toBe('GrimmestDawn');
    expect(stash.sacks).toEqual([]);
  });

  it('rejects a file that is not a transfer stash', () => {
    const buf = Buffer.alloc(64);
    buf.writeUInt32LE(0x55555555, 0); // seed 0 — the magic decodes to 0, not 2
    expect(() => parseTransferStash(buf)).toThrow(/not a Grim Dawn transfer stash/);
  });

  it('degrades to a skipped block rather than a corrupt parse when a sack is malformed', () => {
    // Claim two sacks but write one: the decoder overruns, is rolled back, and
    // the block ends up reported as skipped instead of yielding half-read items.
    const w = new GdWriter(0x99);
    w.writeU32(GST_MAGIC);
    const block = w.beginBlock(18);
    w.writeU32(11);
    w.writeU32NoAdvance(0);
    w.writeStr('');
    w.writeByte(7);
    w.writeU32(2); // lies: says 2 sacks
    const nested = w.beginBlock(0);
    w.writeU32(10);
    w.writeU32(19);
    w.writeU32(0);
    for (let i = 0; i < 5; i++) w.writeU32(0);
    w.endBlock(nested);
    w.endBlock(block);

    const stash = parseTransferStash(w.toBuffer());
    expect(stash.blocks[0]!.status).toBe('skipped');
    expect(stash.sacks).toEqual([]);
    expect(stash.warnings.join('\n')).toMatch(/block 18: decode failed/);
  });
});

// ---------------------------------------------------------------------------
// formulas.gst — synthetic
// ---------------------------------------------------------------------------

/**
 * `formulas.gst` is plaintext, so its "writer" is just a byte builder — there
 * is no cipher and no checksum to mirror.
 */
class PlainWriter {
  private readonly chunks: Buffer[] = [];

  u32(v: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0, 0);
    this.chunks.push(b);
    return this;
  }

  byte(v: number): this {
    this.chunks.push(Buffer.from([v]));
    return this;
  }

  str(s: string): this {
    return this.u32(s.length).raw(Buffer.from(s, 'latin1'));
  }

  raw(b: Buffer): this {
    this.chunks.push(b);
    return this;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

function synthFormulas(records: { record: string; read?: boolean }[], numEntries = records.length): Buffer {
  const w = new PlainWriter();
  w.str('begin_block').u32(0xb01dface);
  w.str('formulasVersion').u32(3);
  w.str('numEntries').u32(numEntries);
  w.str('expansionStatus').byte(7);
  for (const r of records) {
    w.str('itemName').str(r.record);
    w.str('formulaRead').u32(r.read === false ? 0 : 1);
  }
  w.str('end_block').u32(0xdeadc0de);
  return w.toBuffer();
}

describe('formulas.gst', () => {
  it('reads the blueprint list and its header fields', () => {
    const buf = synthFormulas([
      { record: 'records/items/crafting/blueprints/armor/craft_hands.dbr' },
      { record: 'records/items/crafting/blueprints/weapon/craft_omen.dbr', read: false },
    ]);

    const file = parseFormulasFile(buf);
    expect(file.warnings).toEqual([]);
    expect(file.version).toBe(3);
    expect(file.expansionStatus).toBe(7);
    expect(file.entries).toEqual([
      { record: 'records/items/crafting/blueprints/armor/craft_hands.dbr', read: true },
      { record: 'records/items/crafting/blueprints/weapon/craft_omen.dbr', read: false },
    ]);

    expect(parseFormulas(buf)).toEqual(file.entries.map((e) => e.record));
  });

  it('warns when numEntries disagrees with what was read', () => {
    const buf = synthFormulas([{ record: 'records/a.dbr' }], /* numEntries */ 5);
    expect(parseFormulasFile(buf).warnings).toEqual([
      'formulas: numEntries says 5 but 1 were read',
    ]);
  });

  it('rejects a file that is not a formulas file', () => {
    const buf = new PlainWriter().str('not_a_block').u32(0).toBuffer();
    expect(() => parseFormulasFile(buf)).toThrow(/expected "begin_block"/);
  });

  it('fails loudly on an unknown key rather than returning a truncated list', () => {
    // Values are typed by key and carry no length of their own, so there is no
    // way to step over one we do not recognise. Silently stopping would look
    // exactly like a complete parse.
    const w = new PlainWriter();
    w.str('begin_block').u32(0xb01dface);
    w.str('formulasVersion').u32(3);
    w.str('somethingNew').u32(1);
    w.str('end_block').u32(0xdeadc0de);
    expect(() => parseFormulasFile(w.toBuffer())).toThrow(/unknown key "somethingNew"/);
  });
});

// ---------------------------------------------------------------------------
// Live files
// ---------------------------------------------------------------------------

describe.skipIf(!haveTransferStash())('live transfer.gst', () => {
  if (!haveTransferStash()) it.skip(MISSING_GST_MESSAGE, () => {});

  it('parses with every block checksum passing', () => {
    const stash = parseTransferStash(readFileSync(TRANSFER_STASH_PATH), { path: TRANSFER_STASH_PATH });

    // The gate for this parser, exactly as for player.gdc: a passing checksum
    // proves we consumed the file byte-for-byte correctly.
    const unverified = stash.blocks.filter((b) => !b.checksumOk);
    expect(unverified, `blocks failing checksum: ${JSON.stringify(unverified)}`).toEqual([]);
    expect(stash.warnings).toEqual([]);
    expect(stash.blocks.map((b) => b.id)).toEqual([18]);
    expect(stash.blocks[0]!.status).toBe('parsed');
  });

  it('yields sane sacks and item records', () => {
    const stash = parseTransferStash(readFileSync(TRANSFER_STASH_PATH));

    expect(stash.mod).toBe('');
    expect(stash.sacks.length).toBeGreaterThan(0);
    for (const sack of stash.sacks) {
      expect(sack.width).toBeGreaterThan(0);
      expect(sack.height).toBeGreaterThan(0);
      for (const item of sack.items) {
        expect(item.baseName).toMatch(/^records\/.*\.dbr$/);
        expect(item.stackCount).toBeGreaterThanOrEqual(1);
        // Float coordinates, but they address grid cells: whole numbers inside
        // the sack. An i32 misread would blow straight past these bounds.
        expect(Number.isInteger(item.x)).toBe(true);
        expect(item.x).toBeGreaterThanOrEqual(0);
        expect(item.x).toBeLessThan(sack.width);
        expect(item.y).toBeGreaterThanOrEqual(0);
        expect(item.y).toBeLessThan(sack.height);
      }
    }
  });

  it('holds the expected contents for the snapshotted stash', () => {
    // Snapshot-copied so moving items around in game does not break this.
    const stash = parseTransferStash(readFileSync(snapshotSharedSave(TRANSFER_STASH_PATH)));

    expect(stash.version).toBe(11);
    expect(stash.expansionStatus).toBe(7); // all three expansions
    expect(stash.sacks).toHaveLength(2);
    expect(stash.sacks.reduce((n, s) => n + s.items.length, 0)).toBeGreaterThan(10);
    // Stacked consumables are what pins `stackCount` to the right field.
    expect(stash.sacks.flatMap((s) => s.items).some((i) => i.stackCount > 1)).toBe(true);
  });
});

describe.skipIf(!haveFormulas())('live formulas.gst', () => {
  if (!haveFormulas()) it.skip(MISSING_GST_MESSAGE, () => {});

  it('parses every learned blueprint', () => {
    const file = parseFormulasFile(readFileSync(FORMULAS_PATH), { path: FORMULAS_PATH });

    // No checksum exists in this format, so the integrity check is structural:
    // the file must close cleanly and its own numEntries must agree.
    expect(file.warnings).toEqual([]);
    expect(file.entries.length).toBeGreaterThan(0);
    expect(file.expansionStatus).toBe(7);
    for (const entry of file.entries) {
      expect(entry.record).toMatch(/^records\/items\/crafting\/blueprints\/.*\.dbr$/);
    }
    expect(new Set(file.entries.map((e) => e.record)).size).toBe(file.entries.length);
  });
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

describe('CLI error handling', () => {
  it.each(['stash', 'formulas'])('reports a missing file for `%s` without a stack trace', (command) => {
    const missing = join(REPO_ROOT, 'test', 'does-not-exist.gst');
    let stderr = '';
    let status = 0;
    try {
      execFileSync('npx', ['tsx', 'src/cli/index.ts', command, missing], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as { status: number; stderr: string };
      status = e.status;
      stderr = e.stderr;
    }

    expect(status).toBe(1);
    expect(stderr).toContain('does-not-exist.gst');
    expect(stderr).toContain('no such file');
    expect(stderr).not.toMatch(/at .*\(.*:\d+:\d+\)/); // no stack frames
  }, 30_000);
});
