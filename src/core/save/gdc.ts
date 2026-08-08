/**
 * Parser for Grim Dawn character saves (`player.gdc`).
 *
 * Layouts here were derived from gd-explorer's PLAN.md / gd-edit's block
 * enumeration and then *verified empirically* against real 1.3.0.6 saves: every
 * block ends on a checksum equal to the running cipher state, so a block that
 * checksums is a block we consumed byte-for-byte correctly. That makes the
 * checksum, not the spec, the authority — see `parseBlock` in `blocks.js` for
 * how a decoder that disagrees with the file is rejected rather than trusted.
 */

import { finishNested, parseBlock } from './blocks.js';
import { GdReader } from './cipher.js';
import { factionName, factionTier } from './factions.js';
import type {
  Attributes,
  CharacterSave,
  CharacterSkill,
  Difficulty,
  EquippedItem,
  FactionRep,
  ItemInstance,
  PlayStats,
  PositionedItem,
  StashTab,
} from './types.js';

export const GDC_MAGIC = 0x58434447; // "GDCX" little-endian

const DIFFICULTIES: readonly Difficulty[] = ['Normal', 'Elite', 'Ultimate'];

function difficultyOf(raw: number): Difficulty {
  // The high bits carry flags (e.g. "currently in game"); only the low 2 bits
  // select the difficulty.
  return DIFFICULTIES[raw & 0x3] ?? 'Normal';
}

/**
 * The item struct, shared by inventory, stash and (Stage 2) the .gst files.
 *
 * 18 fields on 1.3.0.6, not the 14 the 1.2-era specs describe: two extra words
 * sit between `relicCompletionLevel` and `stackCount`, and two more after it.
 * Verified by consumption + checksum over every item in both test characters —
 * `stackCount` lands where real stack sizes are (13 scavenged plating, 9 cracked
 * lodestone, 1 for gear), which is what pins the extras to those positions.
 */
export function readItem(r: GdReader): ItemInstance {
  const baseName = r.readStr();
  const prefixName = r.readStr();
  const suffixName = r.readStr();
  const modifierName = r.readStr();
  const transmuteName = r.readStr();
  const seed = r.readU32();
  const relicName = r.readStr();
  const relicBonus = r.readStr();
  const relicSeed = r.readU32();
  const augmentName = r.readStr();
  const unknown = r.readU32();
  const augmentSeed = r.readU32();
  const relicCompletionLevel = r.readU32();
  const extra0 = r.readU32();
  const extra1 = r.readU32();
  const stackCount = r.readU32();
  const extra2 = r.readU32();
  const extra3 = r.readU32();
  return {
    baseName,
    prefixName,
    suffixName,
    modifierName,
    transmuteName,
    seed,
    relicName,
    relicBonus,
    relicSeed,
    augmentName,
    unknown,
    augmentSeed,
    relicCompletionLevel,
    stackCount,
    unknownExtra: [extra0, extra1, extra2, extra3],
  };
}

/** An empty item slot is written as an item with a blank base record. */
export function isEmptyItem(item: ItemInstance): boolean {
  return item.baseName === '';
}

/**
 * Grid coordinates follow the item struct. Inventory sacks store them as i32
 * while the personal stash stores them as floats — the same split the .gst
 * stash files have, and the classic porting bug if you assume one everywhere.
 */
function readPositionedItem(r: GdReader, floatCoords: boolean): PositionedItem {
  const item = readItem(r);
  const x = floatCoords ? r.readFloat() : r.readI32();
  const y = floatCoords ? r.readFloat() : r.readI32();
  return { ...item, x, y };
}

function readEquippedItem(r: GdReader): EquippedItem | null {
  const item = readItem(r);
  const attached = r.readBool();
  return isEmptyItem(item) ? null : { ...item, attached };
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

interface ParseState {
  save: CharacterSave;
  warn: (msg: string) => void;
}

/** Block 1 — quest/progression flags, difficulty, iron, tributes. */
function readBlock1(r: GdReader, s: ParseState): void {
  const version = r.readU32();
  if (version !== 5) s.warn(`block 1: unexpected version ${version} (expected 5)`);
  r.readBool(); // inMainQuest
  r.readBool(); // hasBeenInGame
  s.save.difficulty = difficultyOf(r.readByte());
  s.save.greatestDifficultyCompleted = difficultyOf(r.readByte());
  s.save.iron = r.readU32();
  r.readByte(); // greatest survival difficulty completed
  s.save.tributes = r.readU32();
  r.readByte(); // ui compass state
  r.readBool(); // always show loot
  r.readBool(); // show skill help
  r.readBool(); // alt weapon set
  r.readStr(); // player texture (empty on these saves)
  const filterCount = r.readU32();
  for (let i = 0; i < filterCount; i++) r.readByte(); // loot filter toggles
}

/** Block 2 — level, XP, unspent points, core attributes. */
function readBlock2(r: GdReader, s: ParseState): void {
  const version = r.readU32();
  if (version < 5 || version > 8) s.warn(`block 2: unexpected version ${version} (expected 5-8)`);
  const attrs: Attributes = {
    level: r.readI32(),
    experience: r.readI32(),
    attributePoints: r.readU32(),
    skillPoints: r.readU32(),
    devotionPoints: r.readU32(),
    totalDevotionPoints: r.readU32(),
    physique: r.readFloat(),
    cunning: r.readFloat(),
    spirit: r.readFloat(),
    health: r.readFloat(),
    energy: r.readFloat(),
  };
  s.save.attributes = attrs;
}

/**
 * Block 3 — inventory sacks, worn equipment, alternate weapon sets.
 * Sacks are *nested* blocks (id 0), which is why block 3 cannot be blind-skipped.
 */
function readBlock3(r: GdReader, s: ParseState): void {
  const version = r.readU32();
  if (version !== 11 && version !== 4) s.warn(`block 3: unexpected version ${version}`);
  const hasData = r.readBool();
  if (!hasData) return;

  const sackCount = r.readU32();
  r.readI32(); // focused sack
  r.readI32(); // selected sack

  const sacks: PositionedItem[][] = [];
  for (let i = 0; i < sackCount; i++) {
    const sackBlock = r.beginBlock();
    if (sackBlock.id !== 0) throw new Error(`inventory sack ${i}: unexpected nested block id ${sackBlock.id}`);
    r.readBool(); // unused
    const itemCount = r.readU32();
    const items: PositionedItem[] = [];
    for (let j = 0; j < itemCount; j++) items.push(readPositionedItem(r, false));
    finishNested(r, sackBlock, s.warn, `inventory sack ${i}`);
    sacks.push(items);
  }
  s.save.inventorySacks = sacks;

  s.save.alternateWeaponSetActive = r.readBool();
  s.save.equipment = Array.from({ length: 12 }, () => readEquippedItem(r));
  r.readBool(); // alternate set 1 present
  s.save.weaponSet1 = Array.from({ length: 2 }, () => readEquippedItem(r));
  r.readBool(); // alternate set 2 present
  s.save.weaponSet2 = Array.from({ length: 2 }, () => readEquippedItem(r));
}

/** Block 4 — personal stash. Tabs are nested blocks (id 0) with float coords. */
function readBlock4(r: GdReader, s: ParseState): void {
  const version = r.readU32();
  if (version !== 11) s.warn(`block 4: unexpected version ${version} (expected 11)`);
  const tabCount = r.readU32();
  const tabs: StashTab[] = [];
  for (let i = 0; i < tabCount; i++) {
    const tabBlock = r.beginBlock();
    if (tabBlock.id !== 0) throw new Error(`stash tab ${i}: unexpected nested block id ${tabBlock.id}`);
    const width = r.readU32();
    const height = r.readU32();
    const itemCount = r.readU32();
    const items: PositionedItem[] = [];
    for (let j = 0; j < itemCount; j++) items.push(readPositionedItem(r, true));
    // Five trailing words per tab, zero on both test characters. Not described
    // by the 1.2-era specs; read explicitly so a change in their size surfaces
    // as an "undecoded trailing byte(s)" warning rather than passing silently.
    for (let j = 0; j < 5; j++) r.readU32();
    finishNested(r, tabBlock, s.warn, `stash tab ${i}`);
    tabs.push({ width, height, items });
  }
  s.save.personalStash = tabs;
}

/** Block 8 — skills, devotions and item-granted skills. */
function readBlock8(r: GdReader, s: ParseState): void {
  const version = r.readU32();
  if (version < 5 || version > 8) s.warn(`block 8: unexpected version ${version} (expected 5-8)`);
  const skillCount = r.readU32();
  const skills: CharacterSkill[] = [];
  for (let i = 0; i < skillCount; i++) {
    const record = r.readStr();
    const level = r.readI32();
    const enabled = r.readBool();
    r.readByte(); // pads `enabled` to two bytes on 1.3 saves
    const devotionLevel = r.readI32();
    const devotionExperience = r.readI32();
    const sublevel = r.readI32();
    const active = r.readBool();
    r.readByte(); // pads `active` to two bytes on 1.3 saves
    skills.push({
      record,
      level,
      enabled,
      devotionLevel,
      devotionExperience,
      sublevel,
      active,
      autoCastSkill: r.readStr(),
      autoCastController: r.readStr(),
    });
  }

  s.save.skills = skills.filter((sk) => !isDevotionRecord(sk.record));
  s.save.devotions = skills.filter((sk) => isDevotionRecord(sk.record));

  s.save.masteriesAllowed = r.readI32();
  s.save.skillReclamationPointsUsed = r.readI32();
  s.save.devotionReclamationPointsUsed = r.readI32();
  // Two more words follow (zero on both test characters); one is probably the
  // item-granted-skill count. Left undecoded rather than guessed — with no
  // non-empty sample to check against, a wrong guess would parse silently.
}

function isDevotionRecord(record: string): boolean {
  return /\/devotion\//i.test(record) || /skills\/devotion/i.test(record);
}

/** Block 13 — faction reputations. Array index is the faction identity. */
function readBlock13(r: GdReader, s: ParseState): void {
  const version = r.readU32();
  if (version !== 5) s.warn(`block 13: unexpected version ${version} (expected 5)`);
  r.readI32(); // faction selection (currently-favoured faction)
  const count = r.readU32();
  const factions: FactionRep[] = [];
  for (let i = 0; i < count; i++) {
    const changed = r.readBool();
    const unlocked = r.readBool();
    const value = r.readFloat();
    const positiveBoost = r.readFloat();
    const negativeBoost = r.readFloat();
    factions.push({
      id: i,
      name: factionName(i),
      changed,
      unlocked,
      value,
      positiveBoost,
      negativeBoost,
      tier: factionTier(value),
    });
  }
  s.save.factions = factions;
}

/**
 * Block 16 — play statistics. Only the leading fields are decoded; the tail
 * grows with each patch, so the rest is skipped and validated by the checksum.
 */
function readBlock16(r: GdReader, s: ParseState): void {
  const version = r.readU32();
  if (version < 9) s.warn(`block 16: unexpected version ${version}`);
  const stats: PlayStats = {
    playTimeSeconds: r.readU32(),
    deaths: r.readU32(),
    kills: r.readU32(),
  };
  s.save.playStats = stats;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export interface ParseGdcOptions {
  path?: string;
}

export function parseGdc(buf: Buffer, opts: ParseGdcOptions = {}): CharacterSave {
  const warnings: string[] = [];
  const warn = (msg: string) => warnings.push(msg);

  const r = new GdReader(buf);

  const magic = r.readU32();
  if (magic !== GDC_MAGIC) {
    throw new Error(
      `not a Grim Dawn character save: magic 0x${magic.toString(16)} != 0x${GDC_MAGIC.toString(16)}`,
    );
  }
  const headerVersion = r.readU32();
  if (headerVersion !== 1 && headerVersion !== 2) {
    warn(`unexpected header version ${headerVersion} (expected 1 or 2)`);
  }
  const name = r.readWStr();
  const sex = r.readByte();
  const classRecord = r.readStr();
  const level = r.readI32();
  const hardcore = r.readBool();
  const expansionStatus = r.readByte();
  r.verifyChecksum(0); // header block

  const dataVersion = r.readU32();
  if (dataVersion < 6 || dataVersion > 8) {
    warn(`unexpected data version ${dataVersion} (expected 6-8) — parsing anyway`);
  }
  for (let i = 0; i < 16; i++) r.readByte(); // unknown 16-byte field

  const save: CharacterSave = {
    headerVersion,
    dataVersion,
    name,
    sex,
    classRecord,
    level,
    hardcore,
    expansionStatus,
    difficulty: 'Normal',
    greatestDifficultyCompleted: 'Normal',
    iron: 0,
    tributes: 0,
    attributes: {
      level,
      experience: 0,
      attributePoints: 0,
      skillPoints: 0,
      devotionPoints: 0,
      totalDevotionPoints: 0,
      physique: 0,
      cunning: 0,
      spirit: 0,
      health: 0,
      energy: 0,
    },
    skills: [],
    devotions: [],
    masteriesAllowed: 0,
    skillReclamationPointsUsed: 0,
    devotionReclamationPointsUsed: 0,
    equipment: Array.from({ length: 12 }, () => null),
    weaponSet1: [null, null],
    weaponSet2: [null, null],
    alternateWeaponSetActive: false,
    inventorySacks: [],
    personalStash: [],
    factions: [],
    playStats: {
      playTimeSeconds: 0,
      deaths: 0,
      kills: 0,
    },
    blocks: [],
    warnings,
  };
  if (opts.path !== undefined) save.path = opts.path;

  const state: ParseState = { save, warn };

  while (!r.eof) {
    if (r.remaining < 8) {
      warn(`${r.remaining} trailing byte(s) after last block`);
      break;
    }
    const block = r.beginBlock();
    if (block.length > r.remaining) {
      warn(`block ${block.id}: declared length ${block.length} exceeds remaining ${r.remaining}; stopping`);
      break;
    }

    let decode: ((rr: GdReader) => void) | undefined;
    switch (block.id) {
      case 1: decode = (rr) => readBlock1(rr, state); break;
      case 2: decode = (rr) => readBlock2(rr, state); break;
      case 3: decode = (rr) => readBlock3(rr, state); break;
      case 4: decode = (rr) => readBlock4(rr, state); break;
      case 8: decode = (rr) => readBlock8(rr, state); break;
      case 13: decode = (rr) => readBlock13(rr, state); break;
      case 16: decode = (rr) => readBlock16(rr, state); break;
      default: decode = undefined;
    }

    save.blocks.push(parseBlock(r, block, decode, warn));
  }

  return save;
}
