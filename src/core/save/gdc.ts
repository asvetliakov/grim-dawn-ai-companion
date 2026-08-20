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
import { GdReader, type BlockStart } from './cipher.js';
import { factionName, factionTier } from './factions.js';
import { SegWriter, TranscriptRecorder, type Seg, type Transcript } from './transcript.js';
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
 * The mirror of block 2's decoder. `attributePoints` through `energy` are
 * unchanged by a mastery removal, but every field has to be re-emitted: the
 * splice checks the encoding of the whole region against what was read.
 */
export function encodeBlock2(save: CharacterSave, version: number): Seg[] {
  const w = new SegWriter();
  const a = save.attributes;
  w.u32(version);
  w.i32(a.level);
  w.i32(a.experience);
  w.u32(a.attributePoints);
  w.u32(a.skillPoints);
  w.u32(a.devotionPoints);
  w.u32(a.totalDevotionPoints);
  w.f32(a.physique);
  w.f32(a.cunning);
  w.f32(a.spirit);
  w.f32(a.health);
  w.f32(a.energy);
  return w.segments();
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
function readBlock8(r: GdReader, s: ParseState, block: BlockStart): void {
  const version = r.readU32();
  if (version < 5 || version > 8) s.warn(`block 8: unexpected version ${version} (expected 5-8)`);
  const skillCount = r.readU32();
  const skills: CharacterSkill[] = [];
  for (let i = 0; i < skillCount; i++) {
    const record = r.readStr();
    const level = r.readI32();
    const enabled = r.readBool();
    // Not padding: 1 on exactly the 32 GDX3 potion-modifier entries of both
    // test characters. Kept so the block can be written back byte for byte.
    const unknown1 = r.readByte();
    const devotionLevel = r.readI32();
    const devotionExperience = r.readI32();
    const sublevel = r.readI32();
    const active = r.readBool();
    const unknown2 = r.readByte();
    skills.push({
      record,
      level,
      enabled,
      unknown1,
      devotionLevel,
      devotionExperience,
      sublevel,
      active,
      unknown2,
      autoCastSkill: r.readStr(),
      autoCastController: r.readStr(),
    });
  }

  s.save.skillEntries = skills;
  s.save.skills = skills.filter((sk) => !isDevotionRecord(sk.record));
  s.save.devotions = skills.filter((sk) => isDevotionRecord(sk.record));

  s.save.masteriesAllowed = r.readI32();
  s.save.skillReclamationPointsUsed = r.readI32();
  s.save.devotionReclamationPointsUsed = r.readI32();
  // Two more words follow, zero on both test characters; one is probably the
  // item-granted-skill count. Their *meaning* is still a guess, but their width
  // is not: read at byte width they decode to noise (`0,111,113,0,…`) and at
  // word width to two exact zeros, so the game wrote words. They are read here
  // rather than left to the tail skip because an undecoded region cannot be
  // re-enciphered — see `transcript.ts`.
  const tail: number[] = [];
  while (block.bodyEnd - r.offset >= 4) tail.push(r.readU32());
  s.save.skillsTail = tail;
}

/**
 * The mirror of `readBlock8`, field for field and in the same order.
 *
 * Kept beside the decoder on purpose: `spliceRegion` checks the encoding of the
 * *unedited* save against what was actually read, so the two drifting apart is
 * a refusal to write rather than a corrupt save — but only if they are edited
 * together, which they will not be if they live in different files.
 *
 * `version` is not on `CharacterSave`, so it is passed in from the recorded
 * segments rather than guessed.
 */
export function encodeBlock8(save: CharacterSave, version: number): Seg[] {
  const w = new SegWriter();
  w.u32(version);
  w.u32(save.skillEntries.length);
  for (const sk of save.skillEntries) {
    w.str(sk.record);
    w.i32(sk.level);
    w.bool(sk.enabled);
    w.u8(sk.unknown1);
    w.i32(sk.devotionLevel);
    w.i32(sk.devotionExperience);
    w.i32(sk.sublevel);
    w.bool(sk.active);
    w.u8(sk.unknown2);
    w.str(sk.autoCastSkill);
    w.str(sk.autoCastController);
  }
  w.i32(save.masteriesAllowed);
  w.i32(save.skillReclamationPointsUsed);
  w.i32(save.devotionReclamationPointsUsed);
  for (const word of save.skillsTail) w.u32(word);
  return w.segments();
}

function isDevotionRecord(record: string): boolean {
  return /\/devotion\//i.test(record) || /skills\/devotion/i.test(record);
}

/** Block 13 — faction reputations. Array index is the faction identity. */
function readBlock13(r: GdReader, s: ParseState): void {
  const version = r.readU32();
  if (version !== 5) s.warn(`block 13: unexpected version ${version} (expected 5)`);
  s.save.factionSelection = r.readI32(); // the currently-favoured faction
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
 * The mirror of `readBlock13` — what a faction-booster edit splices in.
 *
 * Two of the five per-faction fields are the Writ/Mandate and Warrant
 * multipliers, which is the whole reason this encoder exists: applying a
 * booster is a float, not an item. The floats round-trip bit for bit, and
 * `spliceRegion` proves this reproduces the file field for field before any
 * edited version of it is allowed to replace it.
 */
export function encodeBlock13(save: CharacterSave, version: number): Seg[] {
  const w = new SegWriter();
  w.u32(version);
  w.i32(save.factionSelection);
  w.u32(save.factions.length);
  for (const f of save.factions) {
    w.bool(f.changed);
    w.bool(f.unlocked);
    w.f32(f.value);
    w.f32(f.positiveBoost);
    w.f32(f.negativeBoost);
  }
  return w.segments();
}

/**
 * Block 16 — play statistics.
 *
 * Only three fields are of interest, but the whole block is walked: an
 * undecoded region cannot be re-enciphered (see `transcript.ts`), and block 16
 * sits after block 8, which is the block a mastery removal edits.
 */
function readBlock16(r: GdReader, s: ParseState, block: BlockStart): void {
  const version = r.readU32();
  if (version < 9) s.warn(`block 16: unexpected version ${version}`);
  const stats: PlayStats = {
    playTimeSeconds: r.readU32(),
    deaths: r.readU32(),
    kills: r.readU32(),
  };
  s.save.playStats = stats;

  // experienceFromKills, health/energy potions used, max level, hits received
  // and inflicted, crits inflicted and received, then greatest damage (float).
  for (let i = 0; i < 9; i++) r.readU32();
  // Greatest monster killed, per difficulty: name, level, life+mana, the last
  // monster this character hit, and the last one that hit it.
  for (let i = 0; i < 3; i++) {
    r.readStr();
    r.readU32();
    r.readU32();
    r.readStr();
    r.readStr();
  }
  // champion kills, last hit DA/OA, greatest damage received, hero kills, four
  // crafting counters, shrines, one-shot chests, lore notes (which agrees with
  // block 12's count: 238 and 4 on the two test characters), three boss-kill
  // counters, four survival counters, an empty skills-map count, and the two
  // endless-dungeon currencies.
  for (let i = 0; i < 22; i++) r.readU32();
  r.readByte(); // difficulty skip
  // Unique and randomized items found, plus two words this build adds.
  while (block.bodyEnd - r.offset >= 4) r.readU32();
}

/**
 * Block 14 — UI settings: the skill window, the five skill sets and the hotbar.
 *
 * Decoded for write fidelity rather than for anything on screen. A hot slot is
 * a leading kind word — `-1` empty, `2`/`3` the potion slots, `0` a skill — and
 * only kind 0 carries a payload. Both test characters land on exactly 46 slots
 * with nothing left over, and agree slot for slot on the potions and on the
 * mouse-button defaults; a save that disagrees fails the decode and the block
 * goes back to being opaque, which refuses the edit rather than corrupting it.
 */
function readBlock14(r: GdReader, s: ParseState, block: BlockStart): void {
  const version = r.readU32();
  if (version !== 7) s.warn(`block 14: unexpected version ${version} (expected 7)`);
  r.readBool(); // equipment selection
  r.readI32(); // selected skill window
  r.readBool(); // skill setting valid
  for (let i = 0; i < 5; i++) {
    r.readStr(); // primary skill
    r.readStr(); // secondary skill
    r.readBool(); // set active
  }
  for (let i = 0; i < 3; i++) r.readU32();

  let slots = 0;
  while (block.bodyEnd - r.offset > 8) {
    const kind = r.readI32();
    slots++;
    if (kind !== 0) continue;
    r.readStr(); // skill record
    r.readBool(); // is an item-granted skill
    r.readStr(); // the item granting it
    r.readI32(); // which equipment slot that item sits in
  }
  if (slots !== HOTBAR_SLOTS) s.warn(`block 14: ${slots} hot slots (expected ${HOTBAR_SLOTS})`);
  r.readU32();
  r.readFloat(); // camera distance
}

const HOTBAR_SLOTS = 46;

/** Blocks 12 and 10 — a versioned list of record paths (lore notes, UI flags). */
function readStringListBlock(r: GdReader, block: BlockStart): void {
  r.readU32(); // version
  const count = r.readU32();
  for (let i = 0; i < count; i++) r.readStr();
  while (block.bodyEnd - r.offset >= 4) r.readU32();
}

/**
 * Blocks 5, 6, 7 and 17 — per-difficulty lists of 16-byte world UIDs (respawn
 * points, riftgates, map markers, and whatever 17 tracks).
 *
 * A UID is sixteen *byte* reads, not four words, which is not a distinction the
 * checksum can make — both advance the cipher over the same bytes — but is the
 * difference between writing the file back and corrupting it. It was settled by
 * cross-state agreement instead: at byte width block 5's "current respawn" UIDs
 * are members of its own respawn list and all 72 of block 6's riftgates are
 * identical across the two test characters; at word width neither holds.
 */
function readUidListBlock(r: GdReader, lists: number, trailingUids = 0): void {
  r.readU32(); // version
  for (let i = 0; i < lists; i++) {
    const count = r.readU32();
    for (let j = 0; j < count * 16; j++) r.readByte();
  }
  for (let i = 0; i < trailingUids * 16; i++) r.readByte();
}

/** Block 15 — a versioned list of small numbers (tutorial/UI tokens). */
function readNumberListBlock(r: GdReader, block: BlockStart): void {
  r.readU32(); // version
  const count = r.readU32();
  for (let i = 0; i < count; i++) r.readU32();
  while (block.bodyEnd - r.offset >= 4) r.readU32();
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export interface ParseGdcOptions {
  path?: string;
}

export function parseGdc(buf: Buffer, opts: ParseGdcOptions = {}): CharacterSave {
  return parseGdcInto(buf, opts).save;
}

/**
 * The mirror of the header read in `parseGdcInto`: magic through the trailing
 * standalone checksum. The class tag lives here, which is why a mastery removal
 * has to re-encipher the whole file rather than just the block it edits.
 */
export function encodeHeader(save: CharacterSave): Seg[] {
  const w = new SegWriter();
  w.u32(GDC_MAGIC);
  w.u32(save.headerVersion);
  w.wstr(save.name);
  w.u8(save.sex);
  w.str(save.classRecord);
  w.i32(save.level);
  w.bool(save.hardcore);
  w.u8(save.expansionStatus);
  w.checksum();
  return w.segments();
}

/**
 * Parse *and* record a transcript, so the file can be written back. See
 * `transcript.ts` — the recording costs nothing when nobody asks for it, which
 * is why the plain `parseGdc` stays the default everywhere else.
 */
export function parseGdcRecording(
  buf: Buffer,
  opts: ParseGdcOptions = {},
): { save: CharacterSave; transcript: Transcript } {
  const recorder = new TranscriptRecorder();
  const { save, reader } = parseGdcInto(buf, opts, recorder);
  return { save, transcript: recorder.finish(reader.seed, Buffer.from(reader.restOfFile())) };
}

function parseGdcInto(
  buf: Buffer,
  opts: ParseGdcOptions,
  recorder?: TranscriptRecorder,
): { save: CharacterSave; reader: GdReader } {
  const warnings: string[] = [];
  const warn = (msg: string) => warnings.push(msg);

  const r = new GdReader(buf, recorder);

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
    skillEntries: [],
    skills: [],
    devotions: [],
    masteriesAllowed: 0,
    skillReclamationPointsUsed: 0,
    devotionReclamationPointsUsed: 0,
    skillsTail: [],
    equipment: Array.from({ length: 12 }, () => null),
    weaponSet1: [null, null],
    weaponSet2: [null, null],
    alternateWeaponSetActive: false,
    inventorySacks: [],
    personalStash: [],
    factions: [],
    factionSelection: 0,
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

    let decode: ((rr: GdReader, bb: BlockStart) => void) | undefined;
    switch (block.id) {
      case 1: decode = (rr) => readBlock1(rr, state); break;
      case 2: decode = (rr) => readBlock2(rr, state); break;
      case 3: decode = (rr) => readBlock3(rr, state); break;
      case 4: decode = (rr) => readBlock4(rr, state); break;
      // 5, 6, 7, 10, 12, 14, 15, 16 and 17 hold nothing this tool shows. They
      // are decoded because a save cannot be written back around a region whose
      // field widths are unknown — see `transcript.ts`.
      case 5: decode = (rr) => readUidListBlock(rr, 3, 3); break;
      case 6: decode = (rr) => readUidListBlock(rr, 3); break;
      case 7: decode = (rr) => readUidListBlock(rr, 3); break;
      case 8: decode = (rr, bb) => readBlock8(rr, state, bb); break;
      case 10: decode = (rr, bb) => readStringListBlock(rr, bb); break;
      case 12: decode = (rr, bb) => readStringListBlock(rr, bb); break;
      case 13: decode = (rr) => readBlock13(rr, state); break;
      case 14: decode = (rr, bb) => readBlock14(rr, state, bb); break;
      case 15: decode = (rr, bb) => readNumberListBlock(rr, bb); break;
      case 16: decode = (rr, bb) => readBlock16(rr, state, bb); break;
      case 17: decode = (rr) => readUidListBlock(rr, 6); break;
      default: decode = undefined;
    }

    save.blocks.push(parseBlock(r, block, decode, warn));
  }

  return { save, reader: r };
}
