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
 * The hit-location weights ARE in the game data after all — the
 * `combatRegion<Part>Chance` fields of `records/game/combatformulas.dbr`, read
 * via `GameDb.combatFormulas().hitChances` — and the installed values differ
 * from the community table this list once carried (12/12/24/16/20/16). These
 * entries are the slot roster plus a fallback matching 1.3.0.6's data; the
 * aggregate overlays the live values.
 */
export const ARMOR_PARTS: readonly { slot: string; hitChance: number }[] = [
  { slot: 'Head', hitChance: 15 },
  { slot: 'Shoulders', hitChance: 15 },
  { slot: 'Chest', hitChance: 26 },
  { slot: 'Hands', hitChance: 12 },
  { slot: 'Legs', hitChance: 20 },
  { slot: 'Feet', hitChance: 12 },
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

// ---------------------------------------------------------------------------
// Speed
// ---------------------------------------------------------------------------

/**
 * The character's `+% speed` modifiers, which are the *only* speed terms that
 * come from gear and skills — the base rates live on the player creature record
 * and the weapon term is the weapon's own `characterBaseAttackSpeed`.
 *
 * `characterTotalSpeedModifier` is one field that moves all three at once, so it
 * is kept apart rather than folded in: an advisor weighing a `+5% Total Speed`
 * component against a `+8% Attack Speed` one needs to see that the first also
 * bought casting and movement.
 */
export interface SpeedFields {
  attackPercent: number;
  castPercent: number;
  runPercent: number;
  /** Applies to all three of the above. */
  totalPercent: number;
  /** `+% Maximum …` — raises the engine cap rather than the speed. */
  attackCapPercent: number;
  runCapPercent: number;
}

const SPEED_FIELDS: Readonly<Record<string, keyof SpeedFields>> = {
  characterAttackSpeedModifier: 'attackPercent',
  characterSpellCastSpeedModifier: 'castPercent',
  characterRunSpeedModifier: 'runPercent',
  characterTotalSpeedModifier: 'totalPercent',
  characterAttackSpeedMaxModifier: 'attackCapPercent',
  characterRunSpeedMaxModifier: 'runCapPercent',
};

export function emptySpeed(): SpeedFields {
  return {
    attackPercent: 0,
    castPercent: 0,
    runPercent: 0,
    totalPercent: 0,
    attackCapPercent: 0,
    runCapPercent: 0,
  };
}

export function addSpeed(
  into: SpeedFields,
  stats: Record<string, StatValue>,
  resolve: (value: StatValue) => number,
): SpeedFields {
  for (const [field, value] of Object.entries(stats)) {
    const key = SPEED_FIELDS[field];
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
// Attributes
// ---------------------------------------------------------------------------

/** Save-file naming; the data calls them strength, dexterity, intelligence. */
export type AttrKey = 'physique' | 'cunning' | 'spirit';

export const ATTR_KEYS: readonly AttrKey[] = ['physique', 'cunning', 'spirit'];

/** The DBR fields granting each attribute, flat and percent. */
export const ATTR_FIELDS: Readonly<Record<AttrKey, { flat: string; percent: string }>> = {
  physique: { flat: 'characterStrength', percent: 'characterStrengthModifier' },
  cunning: { flat: 'characterDexterity', percent: 'characterDexterityModifier' },
  spirit: { flat: 'characterIntelligence', percent: 'characterIntelligenceModifier' },
};

/**
 * Attribute and OA/DA contributions from gear and skills. The character's own
 * base (save attributes; the engine's level- and attribute-derived OA/DA floor)
 * is added by the aggregate, not collected here.
 */
export interface AttributeSums {
  flat: Record<AttrKey, number>;
  percent: Record<AttrKey, number>;
  oaFlat: number;
  oaPercent: number;
  daFlat: number;
  daPercent: number;
}

export function emptyAttributes(): AttributeSums {
  return {
    flat: { physique: 0, cunning: 0, spirit: 0 },
    percent: { physique: 0, cunning: 0, spirit: 0 },
    oaFlat: 0,
    oaPercent: 0,
    daFlat: 0,
    daPercent: 0,
  };
}

export function addAttributes(
  into: AttributeSums,
  stats: Record<string, StatValue>,
  resolve: (value: StatValue) => number,
): AttributeSums {
  const read = (field: string): number => {
    const value = stats[field];
    return value === undefined ? 0 : resolve(value);
  };
  for (const key of ATTR_KEYS) {
    const fields = ATTR_FIELDS[key];
    into.flat[key] += read(fields.flat);
    into.percent[key] += read(fields.percent);
  }
  into.oaFlat += read('characterOffensiveAbility');
  into.oaPercent += read('characterOffensiveAbilityModifier');
  into.daFlat += read('characterDefensiveAbility');
  into.daPercent += read('characterDefensiveAbilityModifier');
  return into;
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
  /** Summed flat damage — the min–max midpoint (min alone when no max). */
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
/** `Min` field → its damage key; the matching `Max` is read beside it for the midpoint. */
const FLAT_TO_DAMAGE = new Map<string, DamageKey>();
for (const type of DAMAGE_TYPES) {
  MODIFIER_TO_DAMAGE.set(`offensive${type.stem}Modifier`, type.key);
  FLAT_TO_DAMAGE.set(`offensive${type.stem}Min`, type.key);
  FLAT_TO_DAMAGE.set(`offensiveBase${type.stem}Min`, type.key);
}
// Flat bonus physical, a third spelling the weapon records use alongside the
// base pair. There is no Bonus variant for any other type.
FLAT_TO_DAMAGE.set('offensiveBonusPhysicalMin', 'physical');

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
  // A flat pair is worth its midpoint; a lone Min stands for itself. Reading
  // only the lower bound skewed the type shares — a 165–268 weapon is not a
  // 165 weapon next to a 200–200 one.
  const midpoint = (minField: string, min: StatValue): number => {
    const max = stats[minField.slice(0, -3) + 'Max'];
    const low = resolve(min);
    return max === undefined ? low : (low + resolve(max)) / 2;
  };

  for (const [field, value] of Object.entries(stats)) {
    const modifier = MODIFIER_TO_DAMAGE.get(field);
    if (modifier) {
      bump(into.percent, modifier, resolve(value));
      continue;
    }
    const flat = FLAT_TO_DAMAGE.get(field);
    if (flat) {
      bump(into.flat, flat, midpoint(field, value));
      continue;
    }
    if (field === 'offensiveElementalModifier') {
      for (const key of ELEMENTAL) bump(into.percent, key, resolve(value));
    } else if (field === 'offensiveElementalMin') {
      for (const key of ELEMENTAL) bump(into.flat, key, midpoint(field, value) / 3);
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
 *
 * The DBR type vocabulary is its own dialect: `Poison` is Acid, `Life` is
 * Vitality, `Elemental` stands for fire *and* cold *and* lightning (each
 * converted at the stated % as an in-type; an even three-way split as an
 * out-type), and full-convert transmuters write a semicolon list of every type.
 * Bleeding never appears on either side — no record in the game converts it.
 */
export interface Conversion {
  /** Display name, in the game's own terms (`Vitality`, not `Life`). */
  from: string;
  to: string;
  percent: number;
  /** The instant types the in-side names — `Elemental` and lists expanded. */
  fromKeys: DamageKey[];
  /**
   * The instant types the out-side names. More than one (out-`Elemental`)
   * means the converted damage splits evenly between them.
   */
  toKeys: DamageKey[];
}

/** DBR conversion-type token → the instant damage keys it stands for. */
const CONVERSION_TYPES: Readonly<Record<string, readonly DamageKey[]>> = {
  Physical: ['physical'],
  Pierce: ['pierce'],
  Fire: ['fire'],
  Cold: ['cold'],
  Lightning: ['lightning'],
  Poison: ['acid'],
  Life: ['vitality'],
  Aether: ['aether'],
  Chaos: ['chaos'],
  Elemental: ['fire', 'cold', 'lightning'],
  // `Stun` appears in full-convert lists; stun "damage" is not a damage type
  // the profile tracks, so the token maps to nothing.
};

/**
 * When a type converts, its damage-over-time twin converts with it (Fire takes
 * Burn along, Physical takes Internal Trauma). Pierce, Aether and Chaos have no
 * twin: converting into them leaves the DoT part behind, unconverted.
 */
export const DOT_COUNTERPART: Partial<Record<DamageKey, DamageKey>> = {
  physical: 'internalTrauma',
  fire: 'burn',
  cold: 'frostburn',
  lightning: 'electrocute',
  acid: 'poison',
  vitality: 'vitalityDecay',
};

const DAMAGE_LABEL = new Map(DAMAGE_TYPES.map((t) => [t.key, t.label]));

function conversionKeys(raw: string): DamageKey[] {
  const keys: DamageKey[] = [];
  for (const token of raw.split(';')) {
    for (const key of CONVERSION_TYPES[token.trim()] ?? []) {
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

function conversionLabel(raw: string, keys: DamageKey[]): string {
  if (raw === 'Elemental') return 'Elemental';
  if (keys.length >= 9) return 'All';
  return keys.map((key) => DAMAGE_LABEL.get(key) ?? key).join('/');
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
    if (amount <= 0) continue;
    const fromKeys = conversionKeys(from);
    const toKeys = conversionKeys(to);
    if (fromKeys.length === 0 || toKeys.length === 0) continue;
    out.push({
      from: conversionLabel(from, fromKeys),
      to: conversionLabel(to, toKeys),
      percent: amount,
      fromKeys,
      toKeys,
    });
  }
  return out;
}

/**
 * Apply a set of global conversions to a flat-damage pool, in place of the
 * engine's own arithmetic: everything converts off the *pre-conversion* pool
 * (damage is only ever converted once, never chained), an in-type converted
 * past 100% splits the pool proportionally instead of over-draining it, and
 * each moved amount takes its DoT twin along when the destination has one.
 */
export function applyConversions(
  flat: Partial<Record<DamageKey, number>>,
  rows: readonly Conversion[],
): Partial<Record<DamageKey, number>> {
  // Total % drawn from each in-type, to know when to scale down.
  const drawn: Partial<Record<DamageKey, number>> = {};
  for (const row of rows) {
    for (const key of row.fromKeys) drawn[key] = (drawn[key] ?? 0) + row.percent;
  }

  const out: Partial<Record<DamageKey, number>> = { ...flat };
  const move = (from: DamageKey, to: DamageKey, fraction: number): void => {
    const pool = flat[from];
    if (!pool) return;
    const amount = pool * fraction;
    out[from] = (out[from] ?? 0) - amount;
    out[to] = (out[to] ?? 0) + amount;
  };

  for (const row of rows) {
    for (const from of row.fromKeys) {
      const total = drawn[from] ?? 0;
      const fraction = (row.percent / 100) * (total > 100 ? 100 / total : 1);
      for (const to of row.toKeys) {
        const share = fraction / row.toKeys.length;
        move(from, to, share);
        const fromDot = DOT_COUNTERPART[from];
        const toDot = DOT_COUNTERPART[to];
        if (fromDot && toDot) move(fromDot, toDot, share);
      }
    }
  }
  for (const [key, value] of Object.entries(out) as [DamageKey, number][]) {
    if (Math.abs(value) < 1e-9) delete out[key];
  }
  return out;
}
