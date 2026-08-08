/**
 * Choosing which of the ~130 items a character can reach are worth spending
 * document tokens on.
 *
 * The filter's job is to be *honest about what it dropped*, not to be clever. A
 * candidate that fails its attribute requirement is still data — the advisor
 * decides between an enabler combo, a HOLD-until-level, and a discard — so
 * nothing is cut for failing a check. What gets cut is redundancy: eight
 * candidates per slot, ranked, with the count of what was left out printed
 * beside them.
 *
 * The ranking is deliberately shallow. "Covers a resistance the character is
 * short on" beats "matches the build's damage types" beats rarity beats level
 * proximity, and that is the whole model — a scoring function that tried to
 * simulate the swap would be doing the advisor's job with none of its context.
 */

import type { DbItem } from '../db/types.js';
import { checkRequirements, type CharacterStanding, type RequirementCheck } from '../mechanics/requirements.js';
import {
  addDamage,
  applyConversions,
  conversions,
  DAMAGE_TYPES,
  emptyDamage,
  resistContributions,
  type Conversion,
  type DamageKey,
  type ResistKey,
} from '../mechanics/stats.js';
import type { ResolvedItem } from '../resolve.js';

/** The slot a candidate competes for. Both rings share one group. */
export type EquipGroup =
  | 'Head'
  | 'Shoulders'
  | 'Chest'
  | 'Legs'
  | 'Feet'
  | 'Hands'
  | 'Belt'
  | 'Neck'
  | 'Ring'
  | 'Medal'
  | 'Relic'
  | 'Main hand'
  | 'Off hand';

/** Document order: worn top to bottom, then the hands. */
export const EQUIP_GROUPS: readonly EquipGroup[] = [
  'Head',
  'Shoulders',
  'Chest',
  'Hands',
  'Legs',
  'Feet',
  'Belt',
  'Neck',
  'Ring',
  'Medal',
  'Relic',
  'Main hand',
  'Off hand',
];

const GROUP_BY_CLASS: Readonly<Record<string, EquipGroup>> = {
  ArmorProtective_Head: 'Head',
  ArmorProtective_Shoulders: 'Shoulders',
  ArmorProtective_Chest: 'Chest',
  ArmorProtective_Legs: 'Legs',
  ArmorProtective_Feet: 'Feet',
  ArmorProtective_Hands: 'Hands',
  ArmorProtective_Waist: 'Belt',
  ArmorJewelry_Amulet: 'Neck',
  ArmorJewelry_Ring: 'Ring',
  ArmorJewelry_Medal: 'Medal',
  ItemArtifact: 'Relic',
  WeaponArmor_Shield: 'Off hand',
  WeaponArmor_Offhand: 'Off hand',
};

/** Which equipment group an item competes for, or undefined if it is not gear. */
export function equipGroup(item: DbItem | undefined): EquipGroup | undefined {
  if (!item) return undefined;
  const direct = GROUP_BY_CLASS[item.slot];
  if (direct) return direct;
  return /^Weapon(Melee|Hunting)_/.test(item.slot) ? 'Main hand' : undefined;
}

/** The use-on flag naming a group, for matching a socketable to a slot. */
export const GROUP_SLOT_FLAGS: Readonly<Record<EquipGroup, readonly string[]>> = {
  Head: ['head'],
  Shoulders: ['shoulders'],
  Chest: ['chest'],
  Legs: ['legs'],
  Feet: ['feet'],
  Hands: ['hands'],
  Belt: ['waist'],
  Neck: ['amulet'],
  Ring: ['ring'],
  Medal: ['medal'],
  Relic: [],
  'Main hand': ['sword', 'sword2h', 'axe', 'axe2h', 'mace', 'mace2h', 'dagger', 'scepter', 'spear2h', 'ranged1h', 'ranged2h'],
  'Off hand': ['shield', 'offhand'],
};

// ---------------------------------------------------------------------------
// What an item deals
// ---------------------------------------------------------------------------

export interface DamageIdentity {
  /** Post-armor-piercing, post-own-conversion flat ranges, biggest first. */
  types: { key: DamageKey; label: string; min: number; max: number }[];
  /** The base weapon record's own `% Armor Piercing`, when it has one. */
  pierceRatio: number;
  /** Conversions the item itself grants — global once it is worn. */
  conversions: Conversion[];
}

const SCALAR = (value: unknown): number => (typeof value === 'number' ? value : 0);
const DAMAGE_LABEL = new Map(DAMAGE_TYPES.map((t) => [t.key, t.label]));

/** Every stat block a rolled item carries, merged for a whole-item reading. */
export function itemStatBlocks(item: ResolvedItem): Record<string, number | string>[] {
  const parts = [item.base, item.prefix, item.suffix, item.modifier, item.completion, item.component, item.augment];
  return parts.flatMap((part) => (part ? [part.stats] : []));
}

/**
 * What a weapon actually deals once its own `% Armor Piercing` and its own
 * conversion have been applied. This is the number that decides whether a
 * candidate is on-type: a 100%-physical→pierce gun is a pierce weapon, and
 * ranking it against a physical build's stats would be exactly backwards.
 *
 * Min and Max are tracked separately (rather than the aggregate's midpoint)
 * because the document quotes the range a player would see in the tooltip.
 */
export function damageIdentity(item: ResolvedItem): DamageIdentity {
  const pierceRatio = Math.min(100, SCALAR(item.base?.stats['offensivePierceRatioMin']));
  const ends: [Partial<Record<DamageKey, number>>, Partial<Record<DamageKey, number>>] = [{}, {}];

  for (const [index, end] of (['Min', 'Max'] as const).entries()) {
    const pools = emptyDamage();
    for (const stats of itemStatBlocks(item)) {
      // Read the requested end of every flat pair by hiding the other one: the
      // damage collector takes the midpoint of whatever Min/Max it is given.
      addDamage(pools, oneEnd(stats, end), SCALAR);
    }
    let flat = pools.flat;
    if (pierceRatio > 0 && flat.physical) {
      const moved = flat.physical * (pierceRatio / 100);
      flat = { ...flat, physical: flat.physical - moved, pierce: (flat.pierce ?? 0) + moved };
    }
    ends[index] = applyConversions(flat, itemConversions(item));
  }

  const types = (Object.keys({ ...ends[0], ...ends[1] }) as DamageKey[])
    .map((key) => ({
      key,
      label: DAMAGE_LABEL.get(key) ?? key,
      min: Math.round(ends[0][key] ?? 0),
      max: Math.round(ends[1][key] ?? ends[0][key] ?? 0),
    }))
    .filter((t) => t.min > 0 || t.max > 0)
    .sort((a, b) => b.max - a.max);

  return { types, pierceRatio, conversions: itemConversions(item) };
}

/** Every conversion the item grants once worn — base, affixes, socketables. */
export function itemConversions(item: ResolvedItem): Conversion[] {
  return itemStatBlocks(item).flatMap((stats) => conversions(stats, SCALAR));
}

/**
 * A copy of `stats` whose flat damage pairs read only one end.
 *
 * The damage collector takes the midpoint of whatever `Min`/`Max` pair it is
 * given, so collapsing the pair onto one end is how a single end is read. `Max`
 * keys are simply dropped for the Min pass; the Max pass overwrites each `Min`
 * with its `Max` **in a second pass**, because DBR field order is not
 * guaranteed and a single pass let a later `Min` overwrite the `Max` it had
 * just been given.
 */
function oneEnd(stats: Record<string, number | string>, end: 'Min' | 'Max'): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [field, value] of Object.entries(stats)) {
    if (!field.endsWith('Max')) out[field] = value;
  }
  if (end === 'Max') {
    for (const [field, value] of Object.entries(stats)) {
      if (field.endsWith('Max') && typeof value === 'number') out[`${field.slice(0, -3)}Min`] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface CandidateContext {
  level: number;
  standing: CharacterStanding;
  /** Resistances currently below cap — the holes a candidate could patch. */
  shortfalls: ReadonlySet<ResistKey>;
  /** The build's top damage types, judged post-conversion. */
  topDamage: ReadonlySet<DamageKey>;
  /** Unspent attribute points; each is worth 8 of any attribute. */
  unspentPoints: number;
  /** Items per group before the tail is dropped. */
  perGroup: number;
}

export interface Candidate {
  item: ResolvedItem;
  group: EquipGroup;
  check: RequirementCheck;
  score: number;
  /** Resistances this item covers that the character is short on. */
  covers: ResistKey[];
  /** True when its damage or its conversion feeds a top build type. */
  onType: boolean;
  /** Weapons and off-hands only — what it actually deals. */
  identity?: DamageIdentity;
  /**
   * The attribute gap exceeds unspent points plus a plausible ~15% of gear
   * support. Not a rejection: it ranks last and is cut first under token
   * pressure, because for this character it is a stat-stick.
   */
  outOfReach: boolean;
}

export interface CandidateSelection {
  byGroup: Map<EquipGroup, Candidate[]>;
  /** Group → how many ranked candidates were cut to fit `perGroup`. */
  dropped: Map<EquipGroup, number>;
  /** Items outside the level window, which are not shown at all. */
  outOfWindow: number;
}

/** Over-level candidates matter because "HOLD until level N" is worth saying. */
const LEVEL_WINDOW_ABOVE = 10;
const LEVEL_WINDOW_BELOW = 25;
/** Below this level a Common is still plausibly the best thing on hand. */
const COMMON_CUTOFF_LEVEL = 30;

const RARITY_SCORE: Readonly<Record<string, number>> = {
  Legendary: 24,
  Epic: 18,
  Rare: 12,
  Magical: 6,
  Common: 0,
  Quest: 0,
};

export function selectCandidates(items: readonly ResolvedItem[], ctx: CandidateContext): CandidateSelection {
  const scored = new Map<EquipGroup, Candidate[]>();
  let outOfWindow = 0;

  for (const item of items) {
    if (item.source === 'equipped') continue;
    const group = equipGroup(item.base);
    if (!group || !item.base) continue;

    const level = item.requirements?.level ?? item.base.levelReq;
    if (level > ctx.level + LEVEL_WINDOW_ABOVE || level < ctx.level - LEVEL_WINDOW_BELOW) {
      outOfWindow++;
      continue;
    }

    const covers = coveredShortfalls(item, ctx.shortfalls);
    if (item.base.rarity === 'Common' && ctx.level > COMMON_CUTOFF_LEVEL && covers.length === 0) {
      outOfWindow++;
      continue;
    }

    const identity = group === 'Main hand' || group === 'Off hand' ? damageIdentity(item) : undefined;
    const onType = matchesBuild(item, identity, ctx.topDamage);
    const check = checkRequirements(item, ctx.standing);
    const outOfReach = beyondReach(check, ctx);

    // Lexicographic, not additive: the plan's order is a strict priority, so
    // each term's weight has to exceed the whole range of the ones below it.
    // Two rarity steps must never outrank covering a hole the character has.
    const score =
      covers.length * 10_000 +
      (onType ? 1_000 : 0) +
      (RARITY_SCORE[item.base.rarity] ?? 0) * 10 -
      Math.abs(ctx.level - level) / 10 -
      (outOfReach ? 1_000_000 : 0);

    const list = scored.get(group) ?? [];
    list.push({ item, group, check, score, covers, onType, ...(identity ? { identity } : {}), outOfReach });
    scored.set(group, list);
  }

  const byGroup = new Map<EquipGroup, Candidate[]>();
  const dropped = new Map<EquipGroup, number>();
  for (const group of EQUIP_GROUPS) {
    const list = scored.get(group);
    if (!list?.length) continue;
    list.sort((a, b) => b.score - a.score || a.item.display.localeCompare(b.item.display));
    byGroup.set(group, list.slice(0, ctx.perGroup));
    if (list.length > ctx.perGroup) dropped.set(group, list.length - ctx.perGroup);
  }
  return { byGroup, dropped, outOfWindow };
}

function coveredShortfalls(item: ResolvedItem, shortfalls: ReadonlySet<ResistKey>): ResistKey[] {
  const covered = new Set<ResistKey>();
  for (const stats of itemStatBlocks(item)) {
    for (const [key, amount] of Object.entries(resistContributions(stats, SCALAR)) as [ResistKey, number][]) {
      if (amount > 0 && shortfalls.has(key)) covered.add(key);
    }
  }
  return [...covered];
}

/**
 * Whether the item feeds one of the build's top damage types — by dealing it,
 * by boosting it, or by converting *into* it. The conversion case is the one
 * that matters: an item whose flat damage looks off-type can be exactly right.
 */
function matchesBuild(
  item: ResolvedItem,
  identity: DamageIdentity | undefined,
  top: ReadonlySet<DamageKey>,
): boolean {
  if (top.size === 0) return false;
  for (const type of identity?.types ?? []) {
    if (top.has(type.key)) return true;
  }
  for (const stats of itemStatBlocks(item)) {
    const pools = addDamage(emptyDamage(), stats, SCALAR);
    for (const key of Object.keys(pools.percent) as DamageKey[]) {
      if (pools.percent[key] && top.has(key)) return true;
    }
    for (const conversion of conversions(stats, SCALAR)) {
      if (conversion.toKeys.some((key) => top.has(key))) return true;
    }
  }
  return false;
}

/** Roughly 15% of a character's attributes is what gear plausibly supplies. */
const PLAUSIBLE_GEAR_SUPPORT = 0.15;
/** One unspent attribute point buys 8 of any attribute. */
const POINTS_PER_ATTRIBUTE = 8;

function beyondReach(check: RequirementCheck, ctx: CandidateContext): boolean {
  return check.gaps.some((gap) => {
    if (gap.attr === 'level') return false;
    const reachable = ctx.unspentPoints * POINTS_PER_ATTRIBUTE + gap.have * PLAUSIBLE_GEAR_SUPPORT;
    return gap.deficit > reachable;
  });
}

/**
 * A rough token count. Markdown prose against these stat lines runs a little
 * denser than English, hence 3.6 characters per token rather than 4.
 */
export function estimateTokens(text: string): number {
  return Math.round(text.length / 3.6);
}
