/**
 * Per-character aggregates: where the character's defence actually comes from,
 * and what the build actually deals.
 *
 * The point of doing this at all is that item base stats alone lie. A magical
 * ring's resistances live on its affixes; a component and an augment each add
 * their own; a mastery passive and a devotion node quietly add twenty more. Sum
 * only the items and every hole looks bigger than it is — and the advisor spends
 * a slot patching something the character had already covered.
 *
 * So every source gets its own row, separately attributable. That is what makes
 * a swap computable: drop this augment, and exactly this much aether goes with
 * it. The bands (permanent / + maintainable) exist for the same reason — a
 * resistance that only holds while a 60-second buff is up is a different fact
 * from one stitched into the gear.
 *
 * Deliberately *not* an engine simulation. Everything left out is listed in
 * `exclusions`, because a silent omission is exactly how an item-only sum
 * misleads, and the whole design here is to not do that again one level up.
 */

import type { DbItem, DbSkill, GameDb, StatValue } from '../db/types.js';
import { resolveItem, type ResolvedItem } from '../resolve.js';
import { EQUIP_SLOT_NAMES, type CharacterSave, type Difficulty } from '../save/types.js';
import {
  addDamage,
  addDefense,
  addVector,
  armorAbsorption,
  ARMOR_PARTS,
  conversions,
  DAMAGE_TYPES,
  emptyDamage,
  emptyDefense,
  maxResistContributions,
  penaltyVector,
  RESIST_CAP,
  RESIST_COLUMNS,
  RESIST_HARD_CAP,
  resistContributions,
  RR_FIELDS,
  SECONDARY_RESIST_FIELDS,
  vectorIsEmpty,
  type Conversion,
  type DamageContribution,
  type DamageKey,
  type DefenseFields,
  type ResistKey,
  type ResistVector,
} from './stats.js';
import {
  addSkillBonuses,
  allocatedDevotions,
  atRank,
  classify,
  effectiveRanks,
  emptyBonuses,
  EXCLUSION_REASONS,
  skillLabel,
  statRecord,
  type EffectiveRank,
} from './skills.js';

export type Band = 'permanent' | 'maintainable';

/** Where one row of the matrix came from. */
export type SourceKind =
  | 'base'
  | 'prefix'
  | 'suffix'
  | 'modifier'
  | 'component'
  | 'completion'
  | 'augment'
  | 'set'
  | 'skill'
  | 'devotion';

export interface MatrixRow {
  /** Equipment slot, or the group name for a set / skill / devotion row. */
  slot: string;
  label: string;
  kind: SourceKind;
  band: Band;
  values: ResistVector;
  /** Rank, piece count, or roll variance — whatever qualifies the numbers. */
  note?: string;
}

export interface ResistanceMatrix {
  rows: MatrixRow[];
  /** Items, affixes, components, augments, sets, passives, toggles, devotion. */
  permanent: ResistVector;
  /** `permanent` plus self-buffs the character can keep up indefinitely. */
  withMaintainable: ResistVector;
  /** `+% Maximum Resistance`, which raises the cap rather than the total. */
  maxResist: ResistVector;
  difficulty: Difficulty;
  /**
   * The difficulty penalty, per resistance, read from the game's own balancing
   * record. It is not uniform — Physical takes none, and the four "magical"
   * resistances take half what the elemental ones do.
   */
  penalty: ResistVector;
  /** `withMaintainable + penalty` — what actually applies in play. */
  effective: ResistVector;
  /** 80 per resistance, raised by `maxResist`, ceilinged at 95. */
  caps: ResistVector;
  /** Non-damage resistances, which share neither the cap nor the penalty. */
  secondary: { label: string; value: number }[];
}

export interface DamageEntry {
  key: DamageKey;
  label: string;
  percent: number;
  flat: number;
  overTime: boolean;
}

export interface DamageProfile {
  /** Damage types the build actually invests in, strongest first. */
  ranked: DamageEntry[];
  /** `+% Total Damage` — a multiplier over everything, so it ranks nothing. */
  totalDamagePercent: number;
  conversions: (Conversion & { source: string })[];
  resistReduction: { source: string; effect: string; value: number }[];
  /** Where the skill points went, biggest sink first. */
  skillPoints: EffectiveRank[];
  /**
   * Attack skills that only fire with certain weapons. A weapon swap that
   * ignores this bricks the build's main attack.
   */
  weaponRestrictions: { skill: string; weapons: string[] }[];
}

export interface ArmorSlot {
  slot: string;
  /** Share of incoming physical hits that land here, as a percentage. */
  hitChance: number;
  /** The worn piece's own rating, before character-wide bonuses. */
  piece: number;
  /** `(piece + flat bonuses) × (1 + % bonuses)` — what this part actually meets a hit with. */
  effective: number;
}

export interface DefenseSummary extends DefenseFields {
  /**
   * Armour per body part. Not a total: the engine rolls one location per hit and
   * uses only that piece, so the six ratings are alternatives, not a pool.
   */
  armorSlots: ArmorSlot[];
  /** Hit-weighted mean of the per-part ratings — the honest single number. */
  armorAverage: number;
  /** The part most likely to let a big hit through. */
  weakestSlot?: ArmorSlot;
  /** Resulting absorption after `absorptionPercent` multiplies the base. */
  absorption: number;
  /** The game's base absorption (70), for reference. */
  absorptionBase: number;
  /** True when a shield is equipped — block numbers mean nothing without one. */
  hasShield: boolean;
  armorClasses: string[];
}

export interface SkillModifierNote {
  item: string;
  skill: string;
  /** The modifier record's own name, when it has one — most do not. */
  modifier?: string;
}

export interface CharacterAggregate {
  name: string;
  level: number;
  difficulty: Difficulty;
  /** Which weapon set the aggregate was computed for. */
  weaponSet: 1 | 2;
  resistances: ResistanceMatrix;
  damage: DamageProfile;
  defense: DefenseSummary;
  ranks: EffectiveRank[];
  /** Buffs counted in the maintainable band, so the reader can see the price. */
  maintained: { name: string; rank: number; duration?: number; cooldown?: number }[];
  /** Skills granted by equipped items — named, not summed. */
  grantedSkills: { item: string; skill: string }[];
  /** Item skill modifiers — named, not summed. */
  skillModifiers: SkillModifierNote[];
  /** Everything left out of the numbers above, stated rather than implied. */
  exclusions: string[];
}

// ---------------------------------------------------------------------------
// Equipped sources
// ---------------------------------------------------------------------------

/** One stat-bearing part of the loadout, kept separate so swaps are computable. */
interface Contribution {
  slot: string;
  label: string;
  kind: SourceKind;
  stats: Record<string, StatValue>;
  /** Rank / piece-count reader; scalars for gear, indexed for set bonuses. */
  resolve: (value: StatValue) => number;
  note?: string;
  /**
   * Set on the base item of a slot the engine can roll as a hit location. Its
   * `defensiveProtection` is that body part's own rating, not a global bonus.
   */
  armorPart?: string;
}

const SCALAR = (value: StatValue): number => (typeof value === 'number' ? value : 0);

export interface EquippedSlot {
  slot: string;
  item: ResolvedItem;
}

/**
 * What the character is wearing, by slot.
 *
 * Only the *held* weapon set is included: the other one grants nothing until it
 * is swapped to, and folding both in would inflate every total.
 */
export function equippedSlots(save: CharacterSave, db: GameDb): EquippedSlot[] {
  const out: EquippedSlot[] = [];
  save.equipment.forEach((item, i) => {
    const slot = EQUIP_SLOT_NAMES[i] ?? `Slot ${i}`;
    if (item) out.push({ slot, item: resolveItem(item, db, 'equipped', slot) });
  });
  const held = save.alternateWeaponSetActive ? save.weaponSet2 : save.weaponSet1;
  held.forEach((weapon, i) => {
    const slot = i === 0 ? 'Main hand' : 'Off hand';
    if (weapon) out.push({ slot, item: resolveItem(weapon, db, 'equipped', slot) });
  });
  return out;
}

/** Every stat block the loadout contributes, one per swappable part. */
function contributions(slots: EquippedSlot[], db: GameDb): Contribution[] {
  const out: Contribution[] = [];
  const push = (
    slot: string,
    kind: SourceKind,
    label: string,
    stats: Record<string, StatValue> | undefined,
    note?: string,
    armorPart?: string,
  ): void => {
    if (stats && Object.keys(stats).length) {
      out.push({
        slot,
        label,
        kind,
        stats,
        resolve: SCALAR,
        ...(note ? { note } : {}),
        ...(armorPart ? { armorPart } : {}),
      });
    }
  };

  const armorSlots = new Set(ARMOR_PARTS.map((p) => p.slot));
  for (const { slot, item } of slots) {
    push(
      slot,
      'base',
      item.base?.name ?? item.record,
      item.base?.stats,
      undefined,
      armorSlots.has(slot) ? slot : undefined,
    );
    // Affix numbers are the record's base values; the engine rolls each within
    // ±jitter percent, so they anchor rather than pin down what this item has.
    const jitter = (label: string, pct?: number): string =>
      pct ? `${label}, ±${pct}% roll` : label;
    push(slot, 'prefix', item.prefixName ?? 'prefix', item.prefix?.stats, jitter('prefix', item.prefix?.jitter));
    push(slot, 'suffix', item.suffixName ?? 'suffix', item.suffix?.stats, jitter('suffix', item.suffix?.jitter));
    push(
      slot,
      'modifier',
      item.modifierName ?? 'crafting bonus',
      item.modifier?.stats,
      jitter('modifier', item.modifier?.jitter),
    );
    push(slot, 'component', item.component?.name ?? '', item.component?.stats);
    push(
      slot,
      'completion',
      'completion bonus',
      item.completion?.stats,
      jitter('relic completion', item.completion?.jitter),
    );
    push(slot, 'augment', item.augment?.name ?? '', item.augment?.stats);
  }

  // Set bonuses: every numeric field on a set record is a table indexed by how
  // many pieces are worn, so the piece count is the "rank" it is read at.
  const worn = new Map<string, number>();
  for (const { item } of slots) {
    const set = item.base?.setRecord;
    if (set) worn.set(set, (worn.get(set) ?? 0) + 1);
  }
  for (const [record, pieces] of worn) {
    const set = db.getSet(record);
    if (!set) continue;
    out.push({
      slot: 'Set',
      label: set.name,
      kind: 'set',
      stats: set.bonuses,
      resolve: atRank(pieces),
      note: `${pieces}/${set.members.length} pieces`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The aggregate
// ---------------------------------------------------------------------------

export function aggregateCharacter(
  save: CharacterSave,
  db: GameDb,
  difficulty: Difficulty = save.difficulty,
): CharacterAggregate {
  const slots = equippedSlots(save, db);
  const gear = contributions(slots, db);

  // Ranks first: every skill row below is read at the rank the *current* gear
  // puts the skill at, so the two halves of the aggregate agree with each other.
  const bonuses = emptyBonuses();
  for (const c of gear) addSkillBonuses(bonuses, c.stats, c.resolve);
  const ranks = effectiveRanks(save.skills, bonuses, db);

  const rows: MatrixRow[] = [];
  const permanent: ResistVector = {};
  const maintainable: ResistVector = {};
  const maxResist: ResistVector = {};
  const secondary = new Map<string, number>();
  const defense = emptyDefense();
  /** Body part → the worn piece's own armour rating. */
  const armorPieces = new Map<string, number>();
  const damage = emptyDamage();
  const conversionRows: (Conversion & { source: string })[] = [];
  const rrRows: { source: string; effect: string; value: number }[] = [];
  const excludedReasons = new Set<string>();

  const fold = (
    slot: string,
    label: string,
    kind: SourceKind,
    band: Band,
    stats: Record<string, StatValue>,
    resolve: (value: StatValue) => number,
    note: string | undefined,
    armorPart?: string,
  ): void => {
    const values = resistContributions(stats, resolve);
    if (!vectorIsEmpty(values)) {
      rows.push({ slot, label, kind, band, values, ...(note ? { note } : {}) });
      addVector(band === 'permanent' ? permanent : maintainable, values);
    }
    if (band === 'permanent') {
      addVector(maxResist, maxResistContributions(stats, resolve));
      if (armorPart) {
        const rating = stats['defensiveProtection'];
        if (rating !== undefined) armorPieces.set(armorPart, (armorPieces.get(armorPart) ?? 0) + resolve(rating));
      }
      addDefense(defense, stats, resolve, { protectionIsPieceRating: armorPart !== undefined });
      addDamage(damage, stats, resolve);
      for (const [field, name] of Object.entries(SECONDARY_RESIST_FIELDS)) {
        const value = stats[field] === undefined ? 0 : resolve(stats[field]!);
        if (value) secondary.set(name, (secondary.get(name) ?? 0) + value);
      }
    }
    for (const conversion of conversions(stats, resolve)) {
      conversionRows.push({ ...conversion, source: label });
    }
    for (const [field, effect] of Object.entries(RR_FIELDS)) {
      const value = stats[field] === undefined ? 0 : resolve(stats[field]!);
      if (value) rrRows.push({ source: label, effect, value });
    }
  };

  for (const c of gear) {
    fold(c.slot, c.label, c.kind, 'permanent', c.stats, c.resolve, c.note, c.armorPart);
  }

  // --- skills -------------------------------------------------------------

  const maintained: CharacterAggregate['maintained'] = [];
  for (const entry of save.skills) {
    const skill = db.getSkill(entry.record);
    if (!skill || entry.level < 1) continue;
    const { band, reason } = classify(skill, db);
    if (band === 'rr') {
      collectRR(skill, db, ranks, entry.record, rrRows);
      continue;
    }
    if (band === 'attack') continue;
    if (band === 'excluded') {
      if (reason) excludedReasons.add(reason);
      continue;
    }

    const stats = statRecord(skill, db);
    const rank = ranks.get(entry.record)?.effective ?? entry.level;
    const name = skillLabel(skill, db);
    fold('Skill', name, 'skill', band, stats.stats, atRank(rank), `rank ${rank}`);
    // Only the buff itself goes on the "you must keep this up" list. Its
    // modifier nodes inherit the maintainable band — that is what puts their
    // resistances in the right total — but they are not separately castable.
    if (band === 'maintainable' && stats.duration) {
      maintained.push({
        name,
        rank,
        duration: stats.duration,
        ...(stats.cooldown ? { cooldown: stats.cooldown } : {}),
      });
    }
  }

  // Devotion nodes are per-star; a constellation's stars share a display name,
  // so grouping by it turns 40 one-line rows into one row per constellation.
  const byConstellation = new Map<string, { stats: Record<string, StatValue>[]; stars: number }>();
  for (const entry of allocatedDevotions(save)) {
    const skill = db.getSkill(entry.record);
    if (!skill) continue;
    const { band, reason } = classify(skill, db);
    if (band !== 'permanent') {
      if (reason) excludedReasons.add(reason);
      continue;
    }
    const name = skillLabel(skill, db);
    const group = byConstellation.get(name) ?? { stats: [], stars: 0 };
    group.stats.push(statRecord(skill, db).stats);
    group.stars++;
    byConstellation.set(name, group);
  }
  for (const [name, group] of byConstellation) {
    // Devotion stars are rank-1 by definition (`skillMaxLevel = 1`).
    const merged: Record<string, StatValue> = {};
    for (const stats of group.stats) {
      for (const [field, value] of Object.entries(stats)) {
        const previous = merged[field];
        if (typeof value === 'number') merged[field] = (typeof previous === 'number' ? previous : 0) + value;
        else if (previous === undefined) merged[field] = value;
      }
    }
    fold('Devotion', name, 'devotion', 'permanent', merged, atRank(1), `${group.stars} star(s)`);
  }

  // --- totals -------------------------------------------------------------

  const withMaintainable = addVector(addVector({}, permanent), maintainable);
  const rawPenalty = db.difficultyPenalty(difficulty);
  const penalty = penaltyVector(rawPenalty);
  const effective: ResistVector = {};
  const caps: ResistVector = {};
  for (const column of RESIST_COLUMNS) {
    caps[column.key] = Math.min(RESIST_CAP + (maxResist[column.key] ?? 0), RESIST_HARD_CAP);
    effective[column.key] = (withMaintainable[column.key] ?? 0) + (penalty[column.key] ?? 0);
  }
  // The same table penalises a couple of the non-damage resistances too.
  for (const [field, label] of Object.entries(SECONDARY_RESIST_FIELDS)) {
    const amount = rawPenalty[field];
    if (amount) secondary.set(label, (secondary.get(label) ?? 0) + amount);
  }

  return {
    name: save.name,
    level: save.level,
    difficulty,
    weaponSet: save.alternateWeaponSetActive ? 2 : 1,
    resistances: {
      // Grouped by band so the two totals underneath can be read off the rows
      // above them; within a band the discovery order is the loadout order.
      rows: [...rows].sort((a, b) => Number(a.band === 'maintainable') - Number(b.band === 'maintainable')),
      permanent,
      withMaintainable,
      maxResist,
      difficulty,
      penalty,
      effective,
      caps,
      secondary: [...secondary].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value),
    },
    damage: damageProfile(damage, conversionRows, rrRows, ranks, save, db),
    defense: defenseSummary(defense, armorPieces, slots, db.armorAbsorptionBase()),
    ranks: [...ranks.values()].sort((a, b) => b.invested - a.invested),
    maintained,
    grantedSkills: grantedSkills(slots),
    skillModifiers: skillModifiers(slots, db),
    exclusions: exclusionList(excludedReasons),
  };
}

/**
 * A debuff's negative `defensive<Type>` values are resistance reduction: the
 * enemy loses that much, the player gains nothing. Reported here so the number
 * shows up as the offence it is instead of vanishing.
 */
function collectRR(
  skill: DbSkill,
  db: GameDb,
  ranks: Map<string, EffectiveRank>,
  record: string,
  into: { source: string; effect: string; value: number }[],
): void {
  const stats = statRecord(skill, db);
  const rank = ranks.get(record)?.effective ?? 1;
  const read = atRank(rank);
  const source = skillLabel(skill, db);
  for (const column of RESIST_COLUMNS) {
    const raw = stats.stats[column.field];
    const value = raw === undefined ? 0 : read(raw);
    if (value < 0) into.push({ source, effect: `reduced ${column.label} resistance`, value: -value });
  }
  for (const [field, effect] of Object.entries(RR_FIELDS)) {
    const raw = stats.stats[field];
    const value = raw === undefined ? 0 : read(raw);
    if (value) into.push({ source, effect, value });
  }
}

function damageProfile(
  damage: DamageContribution,
  conversionRows: (Conversion & { source: string })[],
  rrRows: { source: string; effect: string; value: number }[],
  ranks: Map<string, EffectiveRank>,
  save: CharacterSave,
  db: GameDb,
): DamageProfile {
  const ranked: DamageEntry[] = DAMAGE_TYPES.map((type) => ({
    key: type.key,
    label: type.label,
    percent: Math.round(damage.percent[type.key] ?? 0),
    flat: Math.round(damage.flat[type.key] ?? 0),
    overTime: type.overTime,
  }))
    .filter((entry) => entry.percent > 0 || entry.flat > 0)
    // Percent modifiers are what a build commits to; flat damage breaks ties.
    .sort((a, b) => b.percent - a.percent || b.flat - a.flat);

  const weaponRestrictions: DamageProfile['weaponRestrictions'] = [];
  for (const entry of save.skills) {
    if (entry.level < 1) continue;
    const skill = db.getSkill(entry.record);
    if (!skill?.weapons?.length) continue;
    weaponRestrictions.push({ skill: skillLabel(skill, db), weapons: skill.weapons });
  }

  return {
    ranked,
    totalDamagePercent: Math.round(damage.totalPercent),
    conversions: conversionRows,
    resistReduction: rrRows,
    skillPoints: [...ranks.values()].filter((r) => r.invested > 0).sort((a, b) => b.invested - a.invested),
    weaponRestrictions,
  };
}

const SHIELD_CLASS = /Shield/;

function defenseSummary(
  fields: DefenseFields,
  pieces: Map<string, number>,
  slots: EquippedSlot[],
  absorptionBase: number,
): DefenseSummary {
  const armorClasses = new Set<string>();
  let hasShield = false;
  for (const { item } of slots) {
    const classification = item.base?.stats['armorClassification'];
    if (typeof classification === 'string') armorClasses.add(classification);
    if (SHIELD_CLASS.test(item.base?.slot ?? '')) hasShield = true;
  }

  // An empty slot is a rating of zero, and that is exactly the finding worth
  // surfacing — it is a hole every hit that rolls there goes straight through.
  const armorSlots: ArmorSlot[] = ARMOR_PARTS.map((part) => {
    const piece = pieces.get(part.slot) ?? 0;
    return {
      slot: part.slot,
      hitChance: part.hitChance,
      piece,
      effective: (piece + fields.bonusArmor) * (1 + fields.armorPercent / 100),
    };
  });
  const armorAverage = armorSlots.reduce((n, s) => n + (s.effective * s.hitChance) / 100, 0);
  const weakest = armorSlots.reduce((low, s) => (s.effective < low.effective ? s : low), armorSlots[0]!);

  return {
    ...fields,
    armorSlots,
    armorAverage,
    ...(weakest ? { weakestSlot: weakest } : {}),
    absorption: armorAbsorption(absorptionBase, fields.absorptionPercent),
    absorptionBase,
    hasShield,
    armorClasses: [...armorClasses],
  };
}

function grantedSkills(slots: EquippedSlot[]): { item: string; skill: string }[] {
  const out: { item: string; skill: string }[] = [];
  const add = (source: DbItem | undefined): void => {
    if (source?.grantedSkill) out.push({ item: source.name, skill: source.grantedSkill.name });
  };
  for (const { item } of slots) {
    add(item.base);
    add(item.component);
    add(item.augment);
  }
  return out;
}

/**
 * `modifiedSkillName<N>` / `modifierSkillName<N>` pairs: the item says "this
 * skill of yours now also does…". Naming them is in scope; summing their stats
 * is not, and the exclusions list says so.
 */
function skillModifiers(slots: EquippedSlot[], db: GameDb): SkillModifierNote[] {
  const out: SkillModifierNote[] = [];
  for (const { item } of slots) {
    const stats = item.base?.stats;
    if (!stats) continue;
    for (let i = 1; ; i++) {
      const modified = stats[`modifiedSkillName${i}`];
      const modifier = stats[`modifierSkillName${i}`];
      if (typeof modified !== 'string' || typeof modifier !== 'string') break;
      // The modifier record itself is usually anonymous in the data — the game
      // shows its stats inline under the item. Saying "modifies Ring of Steel"
      // and stopping there beats printing a DBR path at the reader.
      const name = db.skillName(modifier);
      out.push({
        item: item.base?.name ?? item.record,
        skill: db.skillName(modified) ?? modified,
        ...(name ? { modifier: name } : {}),
      });
    }
  }
  return out;
}

/**
 * What the numbers above do *not* contain.
 *
 * The fixed entries are structural (they apply to every character); the ones
 * derived from `reasons` name the categories this particular character actually
 * has skills in, so the list is specific rather than boilerplate.
 */
function exclusionList(reasons: Set<string>): string[] {
  const out = [...reasons].map((key) => EXCLUSION_REASONS[key] ?? key);
  out.push(
    'skills granted by items (named above, stats not summed)',
    'item skill modifiers (named above, stats not summed)',
    'attack and retaliation damage, which depend on what is being hit',
    'affix values are the record’s base numbers; the engine rolls each within its jitter',
    // The resistance matrix bands maintainable buffs separately; everything
    // else here is a permanent-sources sum, and saying so beats letting a
    // reader assume the buff's damage bonus is already in the ranking.
    'the damage profile, armour, and non-damage resistances count permanent sources only — maintainable buffs add to the resistance bands and nothing else',
    'a gear swap that changes +skills shifts every rank below, and with it the skill rows above; these numbers are the current loadout’s',
  );
  return [...new Set(out)].sort();
}

/** Column order for anything rendering the matrix. */
export const RESIST_ORDER: readonly ResistKey[] = RESIST_COLUMNS.map((c) => c.key);
