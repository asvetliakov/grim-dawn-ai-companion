/**
 * The game's stat vocabulary, as far as the aggregates need it.
 *
 * Every number in a save's world is a raw DBR key — `defensiveChaos`,
 * `offensiveSlowBleedingModifier` — and this module is the one place that says
 * what each family *means*. Nothing else invents names for game concepts, so the
 * context document and the advisor prompt keep talking in the game's own terms.
 *
 * Two conventions run through the data and are worth stating once:
 *
 * - `defensive<Type>` is a resistance the bearer gains. On an **enemy-facing**
 *   record the same field is written negative, and it is then resistance
 *   *reduction* — never the player's defence. Probing all 1,347 player passives
 *   and 3,405 modifiers found no counter-example: negative means RR, always.
 * - `offensive<Type>Modifier` is +% damage of that type; `offensiveSlow<Type>*`
 *   is the damage-over-time flavour of the same type (Burn, Frostburn,
 *   Electrocute, Bleeding, Internal Trauma, Poison, Vitality Decay).
 */

import type { StatValue } from '../db/types.js';

// ---------------------------------------------------------------------------
// Resistances
// ---------------------------------------------------------------------------

export type ResistKey =
  | 'physical'
  | 'pierce'
  | 'fire'
  | 'cold'
  | 'lightning'
  | 'acid'
  | 'vitality'
  | 'aether'
  | 'chaos'
  | 'bleeding';

export interface ResistColumn {
  key: ResistKey;
  label: string;
  /** The DBR field that grants it directly. */
  field: string;
}

/**
 * The ten damage resistances, in the order the game's character sheet lists
 * them. All ten take the difficulty penalty and share the 80% cap.
 */
export const RESIST_COLUMNS: readonly ResistColumn[] = [
  { key: 'physical', label: 'Physical', field: 'defensivePhysical' },
  { key: 'pierce', label: 'Pierce', field: 'defensivePierce' },
  { key: 'fire', label: 'Fire', field: 'defensiveFire' },
  { key: 'cold', label: 'Cold', field: 'defensiveCold' },
  { key: 'lightning', label: 'Lightning', field: 'defensiveLightning' },
  { key: 'acid', label: 'Acid', field: 'defensivePoison' },
  { key: 'vitality', label: 'Vitality', field: 'defensiveLife' },
  { key: 'aether', label: 'Aether', field: 'defensiveAether' },
  { key: 'chaos', label: 'Chaos', field: 'defensiveChaos' },
  { key: 'bleeding', label: 'Bleeding', field: 'defensiveBleeding' },
];

export const ELEMENTAL: readonly ResistKey[] = ['fire', 'cold', 'lightning'];

export type ResistVector = Partial<Record<ResistKey, number>>;

const RESIST_FIELD_TO_KEY = new Map(RESIST_COLUMNS.map((c) => [c.field, c.key]));

/** Base cap on any one resistance, before `+% Maximum Resistance` raises it. */
export const RESIST_CAP = 80;
/** The ceiling `+% Maximum Resistance` can lift that cap to. */
export const RESIST_HARD_CAP = 95;

/**
 * Turn the game's difficulty balancing row into a signed resistance vector.
 *
 * The difficulty-select screen says "−25% / −50% to all resistances" and that is
 * a simplification: the balancing record penalises Fire, Cold, Lightning, Pierce
 * and Acid a full step ahead of Aether, Chaos, Vitality and Bleeding, and leaves
 * Physical alone entirely. The penalty is subtracted *before* the cap, so
 * staying capped on Ultimate takes 130 points of the resistances that take −50.
 */
export function penaltyVector(penalty: Record<string, number>): ResistVector {
  const out: ResistVector = {};
  for (const column of RESIST_COLUMNS) {
    const amount = penalty[column.field];
    if (amount) out[column.key] = amount;
  }
  return out;
}

export function addVector(into: ResistVector, from: ResistVector): ResistVector {
  for (const [key, value] of Object.entries(from) as [ResistKey, number][]) {
    into[key] = (into[key] ?? 0) + value;
  }
  return into;
}

export function vectorIsEmpty(v: ResistVector): boolean {
  return Object.values(v).every((n) => !n);
}

/**
 * The resistances a stat block grants, expanded.
 *
 * `resolve` reads a possibly-per-rank value at the rank or piece count that
 * applies; passing it in keeps this function free of any notion of ranks.
 * Negative values are dropped here on purpose — they are resistance *reduction*
 * against enemies, and `resistReductions` is where they belong.
 */
export function resistContributions(
  stats: Record<string, StatValue>,
  resolve: (value: StatValue) => number,
): ResistVector {
  const out: ResistVector = {};
  const add = (key: ResistKey, amount: number): void => {
    if (amount > 0) out[key] = (out[key] ?? 0) + amount;
  };

  for (const [field, value] of Object.entries(stats)) {
    const direct = RESIST_FIELD_TO_KEY.get(field);
    if (direct) {
      add(direct, resolve(value));
    } else if (field === 'defensiveElementalResistance') {
      for (const key of ELEMENTAL) add(key, resolve(value));
    } else if (field === 'defensiveAllResistance') {
      for (const column of RESIST_COLUMNS) add(column.key, resolve(value));
    }
  }
  return out;
}

/** `+% Maximum <X> Resistance` — what lifts the 80 cap. */
export function maxResistContributions(
  stats: Record<string, StatValue>,
  resolve: (value: StatValue) => number,
): ResistVector {
  const out: ResistVector = {};
  const add = (key: ResistKey, amount: number): void => {
    if (amount > 0) out[key] = (out[key] ?? 0) + amount;
  };
  for (const [field, value] of Object.entries(stats)) {
    if (field === 'defensiveAllMaxResist') {
      for (const column of RESIST_COLUMNS) add(column.key, resolve(value));
      continue;
    }
    const match = /^defensive(.+)MaxResist$/.exec(field);
    if (!match) continue;
    const column = RESIST_COLUMNS.find((c) => c.field === `defensive${match[1]}`);
    if (column) add(column.key, resolve(value));
  }
  return out;
}

/**
 * Resistances to the things that are not damage: crowd control, leech, reflect.
 * Kept as a flat list rather than a matrix column — they do not share the damage
 * resistances' cap or difficulty penalty, and mixing them in would imply they do.
 */
export const SECONDARY_RESIST_FIELDS: Readonly<Record<string, string>> = {
  defensiveStun: 'Stun',
  defensiveFreeze: 'Freeze',
  defensivePetrify: 'Petrify',
  defensiveTrap: 'Entrapment',
  defensiveDisruption: 'Skill Disruption',
  defensiveTotalSpeedResistance: 'Slow',
  defensiveSlowLifeLeach: 'Life Leech',
  defensiveSlowManaLeach: 'Energy Leech',
  defensivePercentReflectionResistance: 'Reflected Damage',
  defensiveCrowdControl: 'Crowd Control',
  defensiveFireDuration: 'Burn Duration',
  defensiveColdDuration: 'Frostburn Duration',
  defensiveLightningDuration: 'Electrocute Duration',
  defensivePoisonDuration: 'Poison Duration',
  defensiveBleedingDuration: 'Bleeding Duration',
};

// ---------------------------------------------------------------------------
// Defensive skeleton beyond resistances
// ---------------------------------------------------------------------------

/**
 * Armour in Grim Dawn is **localized**, not pooled. Every physical hit rolls a
 * body part and is met by that one piece's rating; the other five contribute
 * nothing to that hit. So the meaningful figure is per part, and a big total can
 * hide a slot that folds to any real hit.
 *
 * These are the engine's hit-location weights. They are not in the game data —
 * `records/game/gameengine.dbr` carries the absorption constant and nothing
 * about locations — so they come from the documented mechanics.
 */
export const ARMOR_PARTS: readonly { slot: string; hitChance: number }[] = [
  { slot: 'Head', hitChance: 12 },
  { slot: 'Shoulders', hitChance: 12 },
  { slot: 'Chest', hitChance: 24 },
  { slot: 'Hands', hitChance: 16 },
  { slot: 'Legs', hitChance: 20 },
  { slot: 'Feet', hitChance: 16 },
];

export interface DefenseFields {
  /**
   * Flat `+Armor` from anywhere that is not itself an armour piece — rings,
   * components, skills. The engine adds it to **every** body part, so it is
   * worth far more than its face value suggests next to a single piece's rating.
   */
  bonusArmor: number;
  /** `+% Armor`, likewise applied per body part. */
  armorPercent: number;
  /**
   * `+% Armor Absorption`. A *multiplier* on the base 70%, not an addend:
   * +20% gives 70 × 1.2 = 84%, not 90%. Absorption caps at 100%.
   */
  absorptionPercent: number;
  blockChance: number;
  blockAmount: number;
  blockAmountPercent: number;
  /** Attack damage converted to health, i.e. sustain. */
  lifeLeechPercent: number;
  health: number;
  healthPercent: number;
}

const DEFENSE_FIELDS: Readonly<Record<string, keyof DefenseFields>> = {
  defensiveBonusProtection: 'bonusArmor',
  defensiveProtectionModifier: 'armorPercent',
  defensiveAbsorptionModifier: 'absorptionPercent',
  defensiveBlockChance: 'blockChance',
  defensiveBlock: 'blockAmount',
  defensiveBlockAmountModifier: 'blockAmountPercent',
  defensiveBlockModifier: 'blockAmountPercent',
  offensiveLifeLeechMin: 'lifeLeechPercent',
  characterLife: 'health',
  characterLifeModifier: 'healthPercent',
};

export function emptyDefense(): DefenseFields {
  return {
    bonusArmor: 0,
    armorPercent: 0,
    absorptionPercent: 0,
    blockChance: 0,
    blockAmount: 0,
    blockAmountPercent: 0,
    lifeLeechPercent: 0,
    health: 0,
    healthPercent: 0,
  };
}

export interface AddDefenseOptions {
  /**
   * True when this stat block is an armour piece worn in a hit location, where
   * `defensiveProtection` is *that piece's* rating rather than a character-wide
   * bonus. The same field means different things depending on where it sits.
   */
  protectionIsPieceRating?: boolean;
}

export function addDefense(
  into: DefenseFields,
  stats: Record<string, StatValue>,
  resolve: (value: StatValue) => number,
  opts: AddDefenseOptions = {},
): DefenseFields {
  for (const [field, value] of Object.entries(stats)) {
    if (field === 'defensiveProtection') {
      if (!opts.protectionIsPieceRating) into.bonusArmor += resolve(value);
      continue;
    }
    const key = DEFENSE_FIELDS[field];
    if (key) into[key] += resolve(value);
  }
  return into;
}

/**
 * Resulting armour absorption. Multiplicative on the base, capped at 100% —
 * beyond which a hit inside the armour's rating is absorbed entirely.
 */
export function armorAbsorption(base: number, percent: number): number {
  return Math.min(base * (1 + percent / 100), 100);
}

// ---------------------------------------------------------------------------
// Damage
// ---------------------------------------------------------------------------

export type DamageKey =
  | 'physical'
  | 'pierce'
  | 'fire'
  | 'cold'
  | 'lightning'
  | 'acid'
  | 'vitality'
  | 'aether'
  | 'chaos'
  | 'bleeding'
  | 'burn'
  | 'frostburn'
  | 'electrocute'
  | 'poison'
  | 'vitalityDecay'
  | 'internalTrauma';

interface DamageType {
  key: DamageKey;
  label: string;
  /** `offensive<stem>Modifier` for +%, `offensive<stem>Min/Max` for flat. */
  stem: string;
  /** True for damage that ticks over time. */
  overTime: boolean;
}

/**
 * The sixteen damage types, keyed by the DBR stem that names them. The
 * over-time ones share their instant counterpart's element (Burn is Fire,
 * Internal Trauma is Physical) but scale off separate stats, so a build that
 * stacks one and not the other has to be told apart.
 */
export const DAMAGE_TYPES: readonly DamageType[] = [
  { key: 'physical', label: 'Physical', stem: 'Physical', overTime: false },
  { key: 'pierce', label: 'Pierce', stem: 'Pierce', overTime: false },
  { key: 'fire', label: 'Fire', stem: 'Fire', overTime: false },
  { key: 'cold', label: 'Cold', stem: 'Cold', overTime: false },
  { key: 'lightning', label: 'Lightning', stem: 'Lightning', overTime: false },
  { key: 'acid', label: 'Acid', stem: 'Poison', overTime: false },
  { key: 'vitality', label: 'Vitality', stem: 'Life', overTime: false },
  { key: 'aether', label: 'Aether', stem: 'Aether', overTime: false },
  { key: 'chaos', label: 'Chaos', stem: 'Chaos', overTime: false },
  { key: 'bleeding', label: 'Bleeding', stem: 'SlowBleeding', overTime: true },
  { key: 'burn', label: 'Burn', stem: 'SlowFire', overTime: true },
  { key: 'frostburn', label: 'Frostburn', stem: 'SlowCold', overTime: true },
  { key: 'electrocute', label: 'Electrocute', stem: 'SlowLightning', overTime: true },
  { key: 'poison', label: 'Poison', stem: 'SlowPoison', overTime: true },
  { key: 'vitalityDecay', label: 'Vitality Decay', stem: 'SlowLife', overTime: true },
  { key: 'internalTrauma', label: 'Internal Trauma', stem: 'SlowPhysical', overTime: true },
];

export interface DamageContribution {
  /** Summed `+%` damage modifiers, per type. */
  percent: Partial<Record<DamageKey, number>>;
  /** Summed flat damage (the `Min` end — the honest lower bound). */
  flat: Partial<Record<DamageKey, number>>;
  /**
   * `+% Total Damage`, kept apart from the per-type numbers on purpose. It
   * scales every type at once, so folding it into them would list all sixteen
   * as invested and hide which ones the build is actually built around — the
   * one question the profile exists to answer.
   */
  totalPercent: number;
}

const MODIFIER_TO_DAMAGE = new Map<string, DamageKey>();
const FLAT_TO_DAMAGE = new Map<string, DamageKey>();
for (const type of DAMAGE_TYPES) {
  MODIFIER_TO_DAMAGE.set(`offensive${type.stem}Modifier`, type.key);
  FLAT_TO_DAMAGE.set(`offensive${type.stem}Min`, type.key);
  FLAT_TO_DAMAGE.set(`offensiveBase${type.stem}Min`, type.key);
}

export function emptyDamage(): DamageContribution {
  return { percent: {}, flat: {}, totalPercent: 0 };
}

/**
 * Fold a stat block into the damage profile.
 *
 * `offensiveElementalModifier` *is* spread, over exactly the three elements it
 * names — a build carrying 300% Elemental and nothing else would otherwise rank
 * as having no damage type at all. `offensiveTotalDamageModifier` is not: see
 * `DamageContribution.totalPercent`.
 */
export function addDamage(
  into: DamageContribution,
  stats: Record<string, StatValue>,
  resolve: (value: StatValue) => number,
): DamageContribution {
  const bump = (bucket: Partial<Record<DamageKey, number>>, key: DamageKey, amount: number): void => {
    if (amount) bucket[key] = (bucket[key] ?? 0) + amount;
  };

  for (const [field, value] of Object.entries(stats)) {
    const modifier = MODIFIER_TO_DAMAGE.get(field);
    if (modifier) {
      bump(into.percent, modifier, resolve(value));
      continue;
    }
    const flat = FLAT_TO_DAMAGE.get(field);
    if (flat) {
      bump(into.flat, flat, resolve(value));
      continue;
    }
    if (field === 'offensiveElementalModifier') {
      for (const key of ELEMENTAL) bump(into.percent, key, resolve(value));
    } else if (field === 'offensiveElementalMin') {
      for (const key of ELEMENTAL) bump(into.flat, key, resolve(value) / 3);
    } else if (field === 'offensiveTotalDamageModifier') {
      into.totalPercent += resolve(value);
    }
  }
  return into;
}

/**
 * Resistance-reduction fields, which is offence wearing defence's clothes: they
 * lower the *enemy's* resistances. Listing them keeps a reader from mistaking a
 * negative `defensive*` on a debuff for a hole in the character's own defence.
 */
export const RR_FIELDS: Readonly<Record<string, string>> = {
  offensiveTotalResistanceReductionAbsoluteMin: 'flat reduction to all resistances',
  offensiveTotalResistanceReductionPercentMin: '% reduction to all resistances',
  offensiveSlowDefensiveReductionMin: 'reduced target resistances',
  offensivePhysicalResistanceReductionPercentMin: '% reduction to physical resistance',
  offensiveSlowDefensiveAbilityMin: 'reduced defensive ability',
  offensiveFumbleMin: 'chance to fumble attacks',
};

/**
 * Damage conversion, which redefines what a build actually deals. A profile that
 * ignores it misranks the build — 100% physical converted to vitality makes a
 * physical weapon a vitality weapon.
 */
export interface Conversion {
  from: string;
  to: string;
  percent: number;
}

export function conversions(
  stats: Record<string, StatValue>,
  resolve: (value: StatValue) => number,
): Conversion[] {
  const out: Conversion[] = [];
  for (const suffix of ['', '2']) {
    const from = stats[`conversionInType${suffix}`];
    const to = stats[`conversionOutType${suffix}`];
    const percent = stats[`conversionPercentage${suffix}`];
    if (typeof from !== 'string' || typeof to !== 'string' || percent === undefined) continue;
    // Some records name a conversion and leave the percentage at zero; the
    // engine converts nothing, so neither does the profile.
    const amount = resolve(percent);
    if (amount > 0) out.push({ from, to, percent: amount });
  }
  return out;
}
