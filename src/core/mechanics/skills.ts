/**
 * Reading a skill at the rank the character actually has it at, and deciding
 * whether its numbers belong in a defensive total.
 *
 * Two rules do most of the work here, and both were checked against the
 * installed 1.3.0.6 archives rather than assumed:
 *
 * 1. **Ranks are array indices.** A leveled stat is a table — `[10,20,29,…]` —
 *    and the value at rank L is `table[L-1]`, clamped to the table's length.
 * 2. **Sign decides direction.** A negative `defensive<Type>` is always
 *    resistance *reduction* applied to enemies, never the player's own defence.
 *    Across every player passive and modifier in the game there is not one
 *    counter-example, which is what makes it safe to lean on.
 */

import type { DbSkill, GameDb, StatValue } from '@grimdawn/core/db/types';
import type { CharacterSave, CharacterSkill } from '@grimdawn/core/save/types';

/**
 * Where a skill's numbers belong.
 *
 * `permanent` and `maintainable` are the two bands the resistance matrix reports;
 * everything else is named so the output can say *why* something was left out,
 * which is the whole difference between an approximation and a misleading one.
 */
export type SkillBand =
  | 'permanent'
  | 'maintainable'
  /** Enemy-facing: resistance reduction and debuffs. Offence, not defence. */
  | 'rr'
  /** An attack. Feeds the damage profile, never the resistance matrix. */
  | 'attack'
  /** Circuit breakers, on-hit procs, potions, pets, temporary buffs. */
  | 'excluded';

/** Why an excluded skill was excluded — the exclusions list in the output. */
export const EXCLUSION_REASONS: Readonly<Record<string, string>> = {
  circuitBreaker: 'circuit breakers (trigger below a life threshold)',
  proc: 'on-hit / on-crit proc buffs and devotion celestial powers',
  temporary: 'buffs whose cooldown outlasts their duration',
  potion: 'potions and consumables',
  pet: 'pet bonuses and pet-only skills',
  party: 'party buffs cast by other players',
  dualWield: 'dual-wield-only skills — this loadout does not dual wield, so their stats are inert',
};

const TOGGLED = new Set([
  'Skill_BuffSelfToggled',
  'Skill_BuffRadiusToggled',
  'Skill_BuffAttackRadiusToggled',
]);

const PASSIVE = new Set(['Skill_Passive', 'SkillBuff_Passive', 'Skill_Mastery']);

const DURATION_BUFF = new Set([
  'Skill_BuffSelfDuration',
  'SkillSecondary_BuffSelfDuration',
  'Skill_BuffRadius',
  'Skill_BuffOther',
  'SkillBuff_Contageous',
]);

const CIRCUIT_BREAKER = /^Skill_PassiveOn(Life|Crit|Attack|Hit)/;
const DEBUFF = /Debuf|Contageous$/;
const ATTACK = /^(Skill|SkillSecondary)_(Attack|WPAttack|WeaponPool|Kick|Move|Evade)/;
const POTION = /Potion/;
const PET = /Pet/;

/** The value of a possibly-leveled stat at a given rank (1-based). */
export function rankValue(value: StatValue, rank: number): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return 0;
  if (value.length === 0) return 0;
  // A rank past the table's end reads its last entry: `skillUltimateLevel` can
  // exceed the array on records the game never lets you push that far.
  const index = Math.min(Math.max(rank, 1), value.length) - 1;
  return value[index] ?? 0;
}

/** Reader for a fixed rank, in the shape `stats.ts` wants. */
export function atRank(rank: number): (value: StatValue) => number {
  return (value) => rankValue(value, rank);
}

/**
 * The record that actually holds a skill's numbers.
 *
 * A toggled aura or a shout is two records: a thin activator carrying nothing
 * but `buffSkillName`, and the buff it applies. Skip the hop and every toggle in
 * the game contributes zero.
 */
export function statRecord(skill: DbSkill, db: GameDb): DbSkill {
  const buff = skill.buffRecord ? db.getSkill(skill.buffRecord) : undefined;
  return buff ?? skill;
}

/**
 * What to call a skill.
 *
 * The activator half of a two-record skill carries no display tag at all — Bone
 * Chilling Cry's activator has neither a name nor a max level, both of which sit
 * on the buff it applies — so the name lookup has to follow the same hop the
 * stats do before falling back to the raw path.
 */
export function skillLabel(skill: DbSkill, db: GameDb): string {
  return skill.name ?? statRecord(skill, db).name ?? db.skillName(skill.record) ?? skill.record;
}

/**
 * The skill a modifier node modifies.
 *
 * The game data carries no parent pointer — checked: not on the record, not in
 * the skill-tree record (an ordered button list), not in the UI panes. What it
 * does have is a naming convention, `veilofshadows2` hanging off
 * `veilofshadows1`, which resolves the modifiers on the mastery trees. Where it
 * does not resolve, banding falls back to the sign rule, which never
 * misattributes a debuff as defence.
 */
export function modifierParent(record: string, db: GameDb): DbSkill | undefined {
  const match = /^(.*\/)([a-z_]+?)(\d+)[a-z]?\.dbr$/.exec(record);
  if (!match) return undefined;
  for (const first of ['1', '01']) {
    const candidate = `${match[1]}${match[2]}${first}.dbr`;
    if (candidate === record) continue;
    const parent = db.getSkill(candidate);
    if (parent) return parent;
  }
  return undefined;
}

/**
 * Which dual-wield family a skill is conditioned on, if any.
 *
 * `dualWieldOnly` / `dualRangedOnly` on the record (verified against 1.3.0.6)
 * mark a skill as inert unless the character dual-wields melee / ranged
 * weapons. The same flags double as the *enabler* marker: Nightblade's Dual
 * Blades ("enables dual wield", per its own FileDescription) is a flagged
 * `Skill_Passive`, and every item whose tooltip says "Allows you to dual
 * wield" grants a flagged skill (Direwolf Claw, Mutilate, Gunslinger's
 * Talent). There is no separate enable field anywhere in the data.
 */
export function dualWieldFlag(skill: DbSkill, db: GameDb): 'melee' | 'ranged' | undefined {
  const stats = statRecord(skill, db);
  const flagged = (key: string): boolean =>
    Boolean(rankValue(skill.stats[key] ?? 0, 1) || rankValue(stats.stats[key] ?? 0, 1));
  if (flagged('dualWieldOnly')) return 'melee';
  if (flagged('dualRangedOnly')) return 'ranged';
  return undefined;
}

export interface Classification {
  band: SkillBand;
  /** Set when `band` is `excluded`; a key of `EXCLUSION_REASONS`. */
  reason?: string;
}

/**
 * Which band a taken skill's stats belong in.
 *
 * Modifiers inherit their parent's band, because a modifier of a maintainable
 * buff is maintainable and a modifier of an enemy debuff is resistance
 * reduction — the same `defensiveCold` field, opposite meanings.
 */
export function classify(skill: DbSkill, db: GameDb, depth = 0): Classification {
  if (PET.test(skill.class)) return { band: 'excluded', reason: 'pet' };
  if (POTION.test(skill.class)) return { band: 'excluded', reason: 'potion' };
  if (CIRCUIT_BREAKER.test(skill.class)) {
    return { band: 'excluded', reason: skill.class.includes('OnLife') ? 'circuitBreaker' : 'proc' };
  }

  const stats = statRecord(skill, db);
  if (DEBUFF.test(stats.class)) return { band: 'rr' };
  if (ATTACK.test(stats.class)) return { band: 'attack' };

  // A devotion node is either a plain passive or the constellation's celestial
  // power, and a celestial power only fires when the skill it is bound to does.
  if (skill.record.startsWith('records/skills/devotion/')) {
    return PASSIVE.has(stats.class) ? { band: 'permanent' } : { band: 'excluded', reason: 'proc' };
  }

  if (stats.class === 'Skill_Modifier' || stats.class === 'Skill_Transmuter') {
    // Depth-guarded: a naming collision could otherwise walk in a circle.
    const parent = depth < 3 ? modifierParent(skill.record, db) : undefined;
    if (parent) return classify(parent, db, depth + 1);
    return { band: 'permanent' };
  }

  if (TOGGLED.has(stats.class) || PASSIVE.has(stats.class)) return { band: 'permanent' };

  if (DURATION_BUFF.has(stats.class)) {
    // The community counts a self-buff you can hold up indefinitely, and so does
    // grimtools when you toggle it on. Anything you cannot hold up is a burst.
    const duration = stats.duration ?? skill.duration ?? 0;
    const cooldown = stats.cooldown ?? skill.cooldown ?? 0;
    if (duration > 0 && duration >= cooldown) return { band: 'maintainable' };
    return { band: 'excluded', reason: 'temporary' };
  }

  return { band: 'excluded', reason: 'proc' };
}

// ---------------------------------------------------------------------------
// Effective ranks
// ---------------------------------------------------------------------------

/** Every `+N to skills` bonus one stat block grants. */
export interface SkillBonuses {
  /** Record path → ranks added. */
  perSkill: Map<string, number>;
  /** Mastery record path → ranks added to every skill in it. */
  perMastery: Map<string, number>;
  /** `+N to all skills`. */
  all: number;
}

export function emptyBonuses(): SkillBonuses {
  return { perSkill: new Map(), perMastery: new Map(), all: 0 };
}

/**
 * Fold one equipped stat block's `+N to <skill>` fields into `into`.
 *
 * The fields come in name/level pairs — `augmentSkillName1` with
 * `augmentSkillLevel1` — and appear identically on items, affixes, components,
 * augments and set bonuses, which is why one function serves all of them.
 */
export function addSkillBonuses(
  into: SkillBonuses,
  stats: Record<string, StatValue>,
  resolve: (value: StatValue) => number,
): SkillBonuses {
  for (const [field, value] of Object.entries(stats)) {
    if (typeof value !== 'string') {
      if (field === 'augmentAllLevel') into.all += resolve(value);
      continue;
    }
    const skill = /^augmentSkillName(\d*)$/.exec(field);
    if (skill) {
      const level = resolve(stats[`augmentSkillLevel${skill[1]}`] ?? 0);
      if (level) into.perSkill.set(value, (into.perSkill.get(value) ?? 0) + level);
      continue;
    }
    const mastery = /^augmentMasteryName(\d*)$/.exec(field);
    if (mastery) {
      const level = resolve(stats[`augmentMasteryLevel${mastery[1]}`] ?? 0);
      if (level) into.perMastery.set(value, (into.perMastery.get(value) ?? 0) + level);
    }
  }
  return into;
}

export interface EffectiveRank {
  record: string;
  name: string;
  /** Points the character spent. */
  invested: number;
  /** Ranks added by equipped gear. */
  bonus: number;
  /** `invested + bonus`, clamped to the skill's ultimate level. */
  effective: number;
  /** True when the clamp bit — extra `+skills` here would be wasted. */
  capped: boolean;
}

/**
 * The rank each pointed skill is really at.
 *
 * Grim Dawn grants no oskills: a `+N to <skill>` bonus does nothing unless the
 * character has spent at least one point in that skill, so unspent skills are
 * absent from the result rather than present at rank N. (Items that *grant* a
 * skill outright are the separate `itemSkillName` mechanism, which this stage
 * names but does not aggregate.)
 */
export function effectiveRanks(
  taken: CharacterSkill[],
  bonuses: SkillBonuses,
  db: GameDb,
): Map<string, EffectiveRank> {
  const out = new Map<string, EffectiveRank>();
  for (const entry of taken) {
    if (entry.level < 1) continue;
    const skill = db.getSkill(entry.record);
    if (!skill) continue;

    const mastery = skill.mastery;
    const bonus =
      (bonuses.perSkill.get(entry.record) ?? 0) +
      (mastery ? (bonuses.perMastery.get(mastery) ?? 0) : 0) +
      bonuses.all;

    // A mastery bar is not a skill; `+N to all skills` must not pump it.
    const isMastery = skill.class === 'Skill_Mastery';
    const stats = statRecord(skill, db);
    const ceiling = stats.ultimateLevel ?? skill.ultimateLevel ?? stats.maxLevel ?? skill.maxLevel;
    const raw = isMastery ? entry.level : entry.level + bonus;
    const effective = ceiling ? Math.min(raw, ceiling) : raw;

    out.set(entry.record, {
      record: entry.record,
      name: skillLabel(skill, db),
      invested: entry.level,
      bonus: isMastery ? 0 : bonus,
      effective,
      capped: effective < raw,
    });
  }
  return out;
}

/** Devotion nodes the character has actually allocated. */
export function allocatedDevotions(save: CharacterSave): CharacterSkill[] {
  // The save lists every node of every constellation the character has touched,
  // including the ones with no point in them — those come through at level 0.
  return save.devotions.filter((d) => d.level >= 1);
}
