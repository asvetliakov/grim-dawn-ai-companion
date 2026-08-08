/**
 * Requirement reductions and the "can this character wear it" check.
 *
 * The game grants `-% Requirement` modifiers scoped by gear family — a medal's
 * "-15% Physique Requirement for Melee weapons" touches a sword but not a
 * chestpiece — plus the affix-only `characterGlobalReqReduction` (every slot,
 * every attribute) and the flat `characterLevelReqReduction` (levels, not
 * percent). Scopes overlap: Melee and Hunting are inside Weapon, and Global
 * sits over everything; all applicable percentages stack additively.
 *
 * The check deliberately reports rather than filters. A reduction — or a flat
 * `+Physique` — can come from the very item a swap would remove, so "meets"
 * is a statement about the character as currently dressed; the advisor is the
 * one equipped to reason about post-swap loadouts and enabler combos.
 */

import type { StatValue } from '../db/types.js';
import type { ItemRequirements, ResolvedItem } from '../resolve.js';
import { ATTR_KEYS, type AttrKey } from './stats.js';

/** `Staff` and `Weapon2H` are defined by the engine but unused in shipped data. */
export type ReqScope =
  | 'Global'
  | 'Armor'
  | 'Jewelry'
  | 'Shield'
  | 'Weapon'
  | 'Melee'
  | 'Hunting'
  | 'Staff'
  | 'Weapon2H';

export interface ReductionRow {
  scope: ReqScope;
  /** Absent on the Global rows, which reduce every attribute. */
  attr?: AttrKey;
  percent: number;
  /** Where it came from — an item name, a skill, a devotion node. */
  source: string;
}

export interface RequirementReductions {
  rows: ReductionRow[];
  /** `characterLevelReqReduction` — flat levels off every item's requirement. */
  levelFlat: number;
}

export function emptyReductions(): RequirementReductions {
  return { rows: [], levelFlat: 0 };
}

const ATTR_BY_DATA_NAME: Readonly<Record<string, AttrKey>> = {
  Strength: 'physique',
  Dexterity: 'cunning',
  Intelligence: 'spirit',
};

const REDUCTION_FIELD =
  /^character(Global|Armor|Jewelry|Shield|Weapon2H|Weapon|Melee|Hunting|Staff)(Strength|Dexterity|Intelligence)?ReqReduction$/;

/**
 * Fold one stat block's reduction fields. Zeros are skipped on purpose: a
 * template spells out every field it has, and fifteen medals carry a zeroed
 * `characterWeaponStrengthReqReduction` that must not become a row.
 */
export function addReqReductions(
  into: RequirementReductions,
  stats: Record<string, StatValue>,
  resolve: (value: StatValue) => number,
  source: string,
): RequirementReductions {
  for (const [field, value] of Object.entries(stats)) {
    if (field === 'characterLevelReqReduction') {
      into.levelFlat += resolve(value);
      continue;
    }
    const match = REDUCTION_FIELD.exec(field);
    if (!match) continue;
    const percent = resolve(value);
    if (!percent) continue;
    const scope = match[1] as ReqScope;
    const attr = match[2] ? ATTR_BY_DATA_NAME[match[2]] : undefined;
    into.rows.push({ scope, ...(attr ? { attr } : {}), percent, source });
  }
  return into;
}

/**
 * Which reduction scopes reach an item, from its base record's template class.
 * A sword sits in Weapon *and* Melee; Global reaches everything.
 */
export function scopesFor(slotClass: string): ReqScope[] {
  const scopes: ReqScope[] = ['Global'];
  if (slotClass.startsWith('ArmorProtective_')) scopes.push('Armor');
  else if (slotClass.startsWith('ArmorJewelry_')) scopes.push('Jewelry');
  else if (slotClass === 'WeaponArmor_Shield') scopes.push('Shield');
  else if (slotClass === 'WeaponArmor_Offhand') scopes.push('Weapon');
  else if (slotClass.startsWith('WeaponMelee_')) {
    scopes.push('Weapon', 'Melee');
    if (/2h$/i.test(slotClass)) scopes.push('Weapon2H');
  } else if (slotClass.startsWith('WeaponHunting_')) {
    scopes.push('Weapon', 'Hunting');
    if (/2h$/i.test(slotClass)) scopes.push('Weapon2H');
  }
  return scopes;
}

export interface RequirementGap {
  attr: AttrKey | 'level';
  have: number;
  need: number;
  deficit: number;
}

export interface RequirementCheck {
  meets: boolean;
  /** After reductions. Rendered so a reader sees what the check compared. */
  effective: ItemRequirements;
  gaps: RequirementGap[];
}

export interface CharacterStanding {
  level: number;
  attributes: Record<AttrKey, number>;
  reductions: RequirementReductions;
}

/**
 * Check one rolled item against a character's current totals. `Math.floor` on
 * the reduced requirement matches the direction the game rounds in — a
 * character exactly at the displayed number can equip the item.
 */
export function checkRequirements(
  item: ResolvedItem,
  standing: CharacterStanding,
): RequirementCheck {
  const raw: ItemRequirements = item.requirements ?? { level: item.base?.levelReq ?? 0 };
  const scopes = new Set(scopesFor(item.base?.slot ?? ''));

  const effective: ItemRequirements = {
    level: Math.max(0, raw.level - standing.reductions.levelFlat),
  };
  const gaps: RequirementGap[] = [];
  if (standing.level < effective.level) {
    gaps.push({
      attr: 'level',
      have: standing.level,
      need: effective.level,
      deficit: effective.level - standing.level,
    });
  }

  for (const key of ATTR_KEYS) {
    const need = raw[key];
    if (need === undefined) continue;
    const percent = standing.reductions.rows
      .filter((row) => scopes.has(row.scope) && (row.attr === undefined || row.attr === key))
      .reduce((sum, row) => sum + row.percent, 0);
    const reduced = Math.floor(need * Math.max(0, 1 - percent / 100));
    effective[key] = reduced;
    const have = Math.floor(standing.attributes[key]);
    if (have < reduced) gaps.push({ attr: key, have, need: reduced, deficit: reduced - have });
  }

  return { meets: gaps.length === 0, effective, gaps };
}
