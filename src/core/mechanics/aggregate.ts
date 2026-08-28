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

import type { DbItem, DbSkill, GameDb, StatValue } from '@grimdawn/core/db/types';
import { resolveItem, type ResolvedItem } from '@grimdawn/core/resolve';
import { EQUIP_SLOT_NAMES, type CharacterSave, type Difficulty } from '@grimdawn/core/save/types';
import {
  addAttributes,
  addDamage,
  addDefense,
  addSpeed,
  addVector,
  applyConversions,
  armorAbsorption,
  ARMOR_PARTS,
  ATTR_KEYS,
  conversions,
  DAMAGE_TYPES,
  emptyAttributes,
  emptyDamage,
  emptyDefense,
  emptySpeed,
  maxResistContributions,
  penaltyVector,
  RESIST_CAP,
  RESIST_COLUMNS,
  RESIST_HARD_CAP,
  resistContributions,
  collectResistReduction,
  SECONDARY_RESIST_FIELDS,
  vectorIsEmpty,
  type AttrKey,
  type Conversion,
  type ResistReductionRow,
  type DamageContribution,
  type DamageKey,
  type DefenseFields,
  type SpeedFields,
  type ResistKey,
  type ResistVector,
} from './stats.js';
import {
  addReqReductions,
  checkRequirements,
  emptyReductions,
  type RequirementCheck,
  type RequirementReductions,
} from './requirements.js';
import {
  addSkillBonuses,
  allocatedDevotions,
  atRank,
  classify,
  dualWieldFlag,
  effectiveRanks,
  emptyBonuses,
  EXCLUSION_REASONS,
  modifierParent,
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
  | 'devotion'
  /** A skill an equipped part grants outright, and that is always on. */
  | 'granted';

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

/**
 * Where a collected conversion applies. Everything worn or permanently active
 * converts the character's damage wholesale (`global`); a maintainable buff's
 * conversion holds only while the buff does. Conversion on an attack skill's
 * own record converts that skill alone and is reported on its `SkillDamage`
 * row instead — it never appears in the global list.
 */
export type ConversionScope = 'global' | 'global (maintainable)';

export interface ScopedConversion extends Conversion {
  source: string;
  scope: ConversionScope;
}

/** What one invested attack skill actually deals. */
export interface SkillDamage {
  skill: string;
  /** The parent skill's record path — the handle for re-reading at another rank. */
  record: string;
  rank: number;
  /** `% Weapon Damage` at that rank — how much of the weapon's payload it inherits. */
  weaponDamagePct?: number;
  /** The skill's own flat damage at that rank (midpoint), before conversion. */
  flat: { key: DamageKey; label: string; amount: number; overTime: boolean }[];
  /**
   * The skill's own `+% damage` at that rank, scoped to this skill alone. Never
   * folded into the global pools — that would misstate every other skill's
   * scaling — which is exactly why it needs its own field to exist at all.
   */
  ownPercent: { key: DamageKey; label: string; percent: number; overTime: boolean }[];
  /** The skill's own `+% Total Damage` (transmuters often write it negative). */
  ownTotalPercent?: number;
  /** Conversions scoped to this skill: its own record plus its modifier/transmuter nodes. */
  conversions: Conversion[];
  /** True for a default-attack replacer (`Skill_WeaponPool_*`). */
  isDefaultAttack: boolean;
  /** The skill's own `% of Attack Damage converted to Health` at that rank — applies to its whole damage, this skill only. */
  lifeLeechPercent?: number;
}

/**
 * The basic weapon attack's damage composition — post-conversion shares of the
 * flat pools. Gear flat damage only ever lands through weapon attacks (or a
 * skill's `% Weapon Damage`), so this is the one place those numbers describe.
 */
export interface WeaponAttackSummary {
  composition: { key: DamageKey; label: string; share: number; overTime: boolean }[];
  /** The invested default-attack replacer, when there is one. */
  mainAttack?: string;
}

export interface DamageProfile {
  /**
   * Damage types the build actually invests in, strongest first. Flat figures
   * are post-conversion: every permanent global conversion has been applied to
   * the pools (converted once, off the raw pool, DoT twins moved along).
   */
  ranked: DamageEntry[];
  /** `+% Total Damage` — a multiplier over everything, so it ranks nothing. */
  totalDamagePercent: number;
  /**
   * The **weapon payload index**: Σ over types of
   * `flat × (1 + (percent + totalDamagePercent) / 100)` — the post-conversion
   * flat pools each scaled by their own `+%` column. One comparable scalar for
   * "what does this plan cost overall", in arbitrary units, and explicitly an
   * index rather than DPS: attack speed, crit, skill `% Weapon Damage`
   * multipliers and the attribute damage bonus are all excluded. The per-skill
   * DPS non-goal stands; this exists so a trade-off can be stated as "−4% of
   * the payload" instead of one type at a time.
   */
  payloadIndex: number;
  conversions: ScopedConversion[];
  weaponAttack: WeaponAttackSummary;
  /** Per-skill damage typing for the invested attack skills, biggest sink first. */
  skillDamage: SkillDamage[];
  /** Everything the build takes off enemy resistances, grouped by stacking category. */
  resistReduction: ResistReductionRow[];
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
  /**
   * Every permanent source of `lifeLeechPercent`, so a swap's sustain cost is
   * attributable the way a resistance's is. Attack skills' own leech is not
   * here — it scopes to that skill (`SkillDamage.lifeLeechPercent`).
   */
  lifeLeechSources: { slot: string; label: string; value: number }[];
}

export interface SkillModifierNote {
  item: string;
  skill: string;
  /** The modifier record's own name, when it has one — most do not. */
  modifier?: string;
}

export interface AttributeTotal {
  /** From the save: starting 50 plus allocated points (8 each). */
  base: number;
  /** Flat bonuses from gear, sets, permanent skills and the mastery bars. */
  flat: number;
  /** `+% <Attribute>` bonuses, applied over base + flat. */
  percent: number;
  total: number;
}

export interface AttributeSummary {
  physique: AttributeTotal;
  cunning: AttributeTotal;
  spirit: AttributeTotal;
  /**
   * OA/DA gear-and-skill contributions only. The engine derives a further base
   * from level and attributes; that floor is not modelled, and the exclusions
   * list says so.
   */
  offensiveAbility: { flat: number; percent: number };
  defensiveAbility: { flat: number; percent: number };
  unspentPoints: number;
}

/** How the held weapon set is configured. */
export type WieldingMode =
  | 'dual-wield melee'
  | 'dual-wield ranged'
  | 'two-hander'
  | 'weapon + shield'
  | 'weapon + caster off-hand'
  | 'single weapon'
  | 'unarmed'
  | 'mixed';

export interface DualWieldEnabler {
  name: string;
  /** `skill` for an invested mastery passive, else `granted by <item>`. */
  source: string;
}

export interface WieldingSummary {
  mode: WieldingMode;
  mainHand?: string;
  offHand?: string;
  /**
   * What legalizes a dual-wield mode. Dual wielding needs an enabler — a
   * mastery passive (Dual Blades, Ranged Expertise) or an item-granted skill —
   * and the character *is* dual-wielding, so an empty list on a dual mode is a
   * model gap, exactly like a failing equipped-requirements check. Non-dual
   * modes always report an empty list.
   */
  enablers: DualWieldEnabler[];
  /**
   * How many enablers are invested mastery passives.
   *
   * Derived because the consequence is what matters and it is easy to miss: a
   * permanent enabler is spent skill points, so while one exists **no gear swap
   * can end dual wielding** and an item's dual-wield grant is worth nothing as a
   * reason to keep it. The first live advice run made exactly that mistake,
   * holding a relic "for the Bloodbath enabler" that two learned passives had
   * already made redundant.
   */
  permanentEnablers: number;
}

/** The base rate one held weapon contributes, before any `+%`. */
export interface WeaponSpeed {
  slot: string;
  item: string;
  /** The localized `Speed: Very Fast` descriptor, without the label. */
  tag: string;
  /** `characterBaseAttackSpeed` — an additive delta in attacks per second. */
  delta: number;
  /** `base + delta`: what this weapon alone swings at, unbuffed. */
  aps: number;
}

/**
 * One speed channel, resolved end to end.
 *
 * The percentages are what a character sheet shows: the resulting rate over the
 * engine baseline. For attack speed that already includes the weapon term,
 * which is why a Very Slow weapon reads under 100% with no modifiers at all and
 * needs half again as many `+%` points to reach the same cap.
 */
export interface SpeedLine {
  label: string;
  /** The engine baseline this channel's percentage is measured against. */
  base: number;
  /** The rate before any `+%` — `base` plus the weapon term, where there is one. */
  weaponBase: number;
  /** How the weapon term was arrived at, when it is not simply the baseline. */
  weaponNote?: string;
  permanentPercent: number;
  maintainablePercent: number;
  /** The cap, after any `+% Maximum …` raised it. */
  cap: number;
  /** Char-sheet percentage from permanent sources only, after the cap. */
  percent: number;
  /** The same including maintainable buffs. */
  percentWithMaintainable: number;
  /** Uncapped, so "how much of this is wasted" is answerable. */
  rawPercent: number;
  rawPercentWithMaintainable: number;
  /** `base × percent / 100` — attacks or casts per second, or the movement rate. */
  rate: number;
  rateWithMaintainable: number;
  /**
   * Modifier points that can still be added before the cap bites, counting the
   * maintainable band as held. Zero means every further `+%` is wasted.
   */
  headroom: number;
}

export interface SpeedSummary {
  attack: SpeedLine;
  cast: SpeedLine;
  movement: SpeedLine;
  /** The held weapons' own base rates, which is where the attack term comes from. */
  weapons: WeaponSpeed[];
  /** `characterTotalSpeedModifier`, which moved all three lines at once. */
  totalSpeedPercent: { permanent: number; maintainable: number };
}

export interface CharacterAggregate {
  name: string;
  level: number;
  difficulty: Difficulty;
  /** Which weapon set the aggregate was computed for. */
  weaponSet: 1 | 2;
  wielding: WieldingSummary;
  resistances: ResistanceMatrix;
  damage: DamageProfile;
  defense: DefenseSummary;
  /**
   * Attack, casting and movement speed against the engine caps. Attack speed is
   * a throughput multiplier on everything in `damage`, so ranking damage without
   * it ranks half the answer — and both Stage 6 live runs said outright that
   * they could not tell whether the character was already at the cap.
   */
  speed: SpeedSummary;
  ranks: EffectiveRank[];
  /** Buffs counted in the maintainable band, so the reader can see the price. */
  maintained: { name: string; rank: number; duration?: number; cooldown?: number }[];
  /** Skills granted by equipped items — named, not summed. */
  grantedSkills: {
    /** The part granting it — a component's skill leaves with the component. */
    item: string;
    skill: string;
    /** True when its stats are summed: an always-on passive or a toggle. */
    counted: boolean;
    /** `always on`, `toggle`, or why it is not counted. */
    activation: string;
  }[];
  /** Item skill modifiers — named, not summed. */
  skillModifiers: SkillModifierNote[];
  attributes: AttributeSummary;
  /** Every `-% Requirement` modifier the loadout and build carry. */
  requirementReductions: RequirementReductions;
  /**
   * Every equipped item checked against the totals above. The character is
   * wearing all of it, so every entry should hold — a failure means the model
   * (not the character) is wrong, and the tests enforce exactly that.
   */
  equippedRequirements: { slot: string; item: string; check: RequirementCheck }[];
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

/** The three spellings a weapon's flat physical can arrive under. */
const WEAPON_PHYSICAL_STEMS = ['offensivePhysical', 'offensiveBasePhysical', 'offensiveBonusPhysical'];

/**
 * `% Armor Piercing` is conversion wearing a weapon stat's clothes: the stated
 * share of the weapon's physical damage is dealt as pierce instead — and only
 * the physical; the weapon's other flats are untouched. The ratio is the base
 * weapon record's own and nothing else's: no component, affix or skill in the
 * installed data carries `offensivePierceRatioMin` (verified — 270 carriers,
 * all weapons; the old "+% Armor Piercing" component bonuses left the game
 * years ago, and stacked multiplicatively when they existed). It converts the
 * weapon's whole physical payload, affix flats included, so it is applied here
 * per part before the pools ever see the numbers. Min and Max move together,
 * which keeps the midpoint arithmetic downstream exact.
 */
function applyPierceRatio(parts: Contribution[]): void {
  const base = parts.find((c) => c.kind === 'base');
  const ratio = Math.min(100, SCALAR(base?.stats['offensivePierceRatioMin'] ?? 0));
  if (ratio <= 0) return;
  const fraction = ratio / 100;
  for (const c of parts) {
    let stats: Record<string, StatValue> | undefined;
    for (const stem of WEAPON_PHYSICAL_STEMS) {
      const min = c.stats[`${stem}Min`];
      if (typeof min !== 'number' || min === 0) continue;
      // A lone Min means min = max; materialize both ends on both types so the
      // moved range stays a range and never leaves a Max below its Min.
      const rawMax = c.stats[`${stem}Max`];
      const max = typeof rawMax === 'number' ? rawMax : min;
      stats ??= { ...c.stats };
      stats[`${stem}Min`] = min * (1 - fraction);
      stats[`${stem}Max`] = max * (1 - fraction);
      const pierceMin = SCALAR(stats['offensivePierceMin'] ?? 0);
      const rawPierceMax = stats['offensivePierceMax'];
      const pierceMax = typeof rawPierceMax === 'number' ? rawPierceMax : pierceMin;
      stats['offensivePierceMin'] = pierceMin + min * fraction;
      stats['offensivePierceMax'] = pierceMax + max * fraction;
    }
    if (stats) c.stats = stats;
  }
}

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

export const MELEE_1H = /^WeaponMelee_(Sword|Axe|Mace|Dagger|Scepter)$/;
export const RANGED_1H = 'WeaponHunting_Ranged1h';

/**
 * How the held weapons are configured, and — for the dual-wield modes — what
 * makes that legal.
 *
 * Dual wielding needs an enabler. The data marks enablement and
 * DW-conditionality with the same flags (`dualWieldOnly` / `dualRangedOnly`,
 * see `dualWieldFlag`), so telling the two apart is a documented heuristic:
 * an *invested mastery skill* counts only when it is a plain passive (Dual
 * Blades, Berserker's Implements of War; the flagged WPS attacks and
 * transmuters beside them merely require dual wielding), while an
 * *item-granted* flagged skill of any class counts — every item whose tooltip
 * reads "Allows you to dual wield" grants one (Direwolf Claw, Mutilate,
 * Slaughter's Bloodbath, Gunslinger's Talent), and no other item does.
 */
const ENABLER_PASSIVE = new Set(['Skill_Passive', 'SkillBuff_Passive', 'Skill_PassiveDualWieldWeapon']);

function wieldingSummary(slots: EquippedSlot[], save: CharacterSave, db: GameDb): WieldingSummary {
  const main = slots.find((s) => s.slot === 'Main hand')?.item;
  const off = slots.find((s) => s.slot === 'Off hand')?.item;
  const mainCls = main?.base?.slot ?? '';
  const offCls = off?.base?.slot ?? '';

  let mode: WieldingMode = 'mixed';
  if (!main && !off) mode = 'unarmed';
  else if (/2h$/i.test(mainCls)) mode = 'two-hander';
  else if (offCls === 'WeaponArmor_Shield') mode = 'weapon + shield';
  else if (offCls === 'WeaponArmor_Offhand') mode = 'weapon + caster off-hand';
  else if (MELEE_1H.test(mainCls) && MELEE_1H.test(offCls)) mode = 'dual-wield melee';
  else if (mainCls === RANGED_1H && offCls === RANGED_1H) mode = 'dual-wield ranged';
  else if (main && !off) mode = 'single weapon';

  const enablers: DualWieldEnabler[] = [];
  const family = mode === 'dual-wield melee' ? 'melee' : mode === 'dual-wield ranged' ? 'ranged' : undefined;
  if (family) {
    for (const entry of save.skills) {
      if (entry.level < 1) continue;
      const skill = db.getSkill(entry.record);
      if (!skill || dualWieldFlag(skill, db) !== family) continue;
      if (!ENABLER_PASSIVE.has(statRecord(skill, db).class)) continue;
      enablers.push({ name: skillLabel(skill, db), source: 'skill' });
    }
    for (const granted of grantedSkillRefs(slots, db)) {
      const skill = db.getSkill(granted.record);
      if (!skill || dualWieldFlag(skill, db) !== family) continue;
      enablers.push({ name: granted.name, source: `granted by ${granted.part}` });
    }
  }

  return {
    mode,
    ...(main?.base ? { mainHand: main.base.name } : {}),
    ...(off?.base ? { offHand: off.base.name } : {}),
    enablers,
    permanentEnablers: enablers.filter((e) => e.source === 'skill').length,
  };
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

  for (const hand of ['Main hand', 'Off hand']) {
    applyPierceRatio(out.filter((c) => c.slot === hand));
  }

  // Set bonuses: every numeric field on a set record is a table indexed by how
  // many pieces are worn, so the piece count is the "rank" it is read at.
  // The engine counts *distinct* set members — a second copy of the same ring
  // does not advance the counter (verified in game) — hence the Set, not a tally.
  const worn = new Map<string, Set<string>>();
  for (const { item } of slots) {
    const set = item.base?.setRecord;
    if (!set) continue;
    const members = worn.get(set) ?? new Set<string>();
    members.add(item.record);
    worn.set(set, members);
  }
  for (const [record, members] of worn) {
    const set = db.getSet(record);
    if (!set) continue;
    const pieces = members.size;
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
  const wielding = wieldingSummary(slots, save, db);

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
  const leechSources: DefenseSummary['lifeLeechSources'] = [];
  // Speed bands separately: Veil of Shadow's -12% Total Speed is permanent and
  // Pneumatic Burst's +5% is not, so a single number would be wrong twice.
  const speedPermanent = emptySpeed();
  const speedMaintainable = emptySpeed();
  /** Body part → the worn piece's own armour rating. */
  const armorPieces = new Map<string, number>();
  const damage = emptyDamage();
  const conversionRows: ScopedConversion[] = [];
  const rrRows: ResistReductionRow[] = [];
  const excludedReasons = new Set<string>();
  const attrSums = emptyAttributes();
  const reductions = emptyReductions();
  // Declared here rather than beside the invested-skill loop because gear can
  // grant a maintainable buff too, and that fold runs first.
  const maintained: CharacterAggregate['maintained'] = [];

  const fold = (
    slot: string,
    label: string,
    kind: SourceKind,
    band: Band,
    stats: Record<string, StatValue>,
    resolve: (value: StatValue) => number,
    note: string | undefined,
    armorPart?: string,
    rrMeta?: { rank?: number; record?: string },
  ): void => {
    const values = resistContributions(stats, resolve);
    if (!vectorIsEmpty(values)) {
      rows.push({ slot, label, kind, band, values, ...(note ? { note } : {}) });
      addVector(band === 'permanent' ? permanent : maintainable, values);
    }
    addSpeed(band === 'permanent' ? speedPermanent : speedMaintainable, stats, resolve);
    if (band === 'permanent') {
      addVector(maxResist, maxResistContributions(stats, resolve));
      if (armorPart) {
        const rating = stats['defensiveProtection'];
        if (rating !== undefined) armorPieces.set(armorPart, (armorPieces.get(armorPart) ?? 0) + resolve(rating));
      }
      addDefense(defense, stats, resolve, { protectionIsPieceRating: armorPart !== undefined });
      const leech = stats['offensiveLifeLeechMin'];
      if (leech !== undefined) {
        const value = resolve(leech);
        if (value) leechSources.push({ slot, label, value });
      }
      addDamage(damage, stats, resolve);
      addAttributes(attrSums, stats, resolve);
      addReqReductions(reductions, stats, resolve, label);
      for (const [field, name] of Object.entries(SECONDARY_RESIST_FIELDS)) {
        const value = stats[field] === undefined ? 0 : resolve(stats[field]!);
        if (value) secondary.set(name, (secondary.get(name) ?? 0) + value);
      }
    }
    // Gear and permanent skills convert the character's damage wholesale; a
    // maintainable buff's conversion only holds while the buff does. Attack
    // skills never reach this fold — their conversions are skill-scoped and
    // live on the SkillDamage rows.
    for (const conversion of conversions(stats, resolve)) {
      conversionRows.push({
        ...conversion,
        source: label,
        scope: band === 'maintainable' ? 'global (maintainable)' : 'global',
      });
    }
    // Negative `defensive*` reads as enemy RR only off skill and devotion
    // records; on gear it is the item's own drawback and stays out of this list.
    collectResistReduction(stats, resolve, label, rrRows, {
      negativeDefensiveIsRR: kind === 'skill' || kind === 'devotion',
      ...rrMeta,
    });
  };

  for (const c of gear) {
    fold(c.slot, c.label, c.kind, 'permanent', c.stats, c.resolve, c.note, c.armorPart);
  }

  // --- skills granted by gear ---------------------------------------------
  //
  // A granted skill is banded exactly as an invested one, because it is the
  // same mechanic: a passive or a toggle is on, so it is summed on its own
  // attributable row, and a proc, an activated attack or a pet skill is named
  // and left out. Lumping all six kinds under "named, not summed" cost real
  // advice — a relic whose aura carries +125% Cold Damage read as its own
  // +36% line, so swapping it away looked like a damage gain.
  //
  // None of these is in `save.skills` (the game does not persist a granted
  // skill as a character skill), but one that somehow is stays with the
  // invested fold rather than being counted twice.
  const investedRecords = new Set(save.skills.filter((s) => s.level > 0).map((s) => s.record));
  const grantedSkills: CharacterAggregate['grantedSkills'] = [];
  for (const g of grantedSkillRefs(slots, db)) {
    const skill = db.getSkill(g.record);
    if (!skill || investedRecords.has(g.record)) continue;
    const stats = statRecord(skill, db);
    // The activator carries the toggled class; the buff it points at is a
    // plain passive, so asking the buff would call every aura "always on".
    const toggle = /Toggled/.test(skill.class) || /Toggled/.test(stats.class);
    const { band, reason } = classify(skill, db);
    // Every granting part counts, including a second copy of the same one:
    // two Vicious Spikes are two buffs, and so are two Coldstones. That is
    // the opposite of the set-bonus rule, where a duplicate member adds
    // nothing — both are in-game facts, neither is in the data.
    const counted = band === 'permanent' || band === 'maintainable';
    grantedSkills.push({
      item: g.part,
      skill: g.name,
      counted,
      activation: counted ? (toggle ? 'toggle' : 'always on') : (reason ?? 'cast or triggered'),
    });
    if (!counted) {
      excludedReasons.add(reason ?? 'grantedActive');
      continue;
    }
    // A toggle's energy reservation is the cost of having it on, and the one
    // reason a reader might discount the row — so the row says it.
    const reserve = stats.stats['characterManaLimitReserve'];
    const reserved = typeof reserve === 'number' && reserve ? `, reserves ${reserve}% energy` : '';
    fold(
      g.slot,
      g.name,
      'granted',
      band,
      stats.stats,
      atRank(g.rank),
      `granted by ${g.part}, ${toggle ? 'toggle' : 'always on'}${reserved}`,
    );
    if (band === 'maintainable' && stats.duration) {
      maintained.push({
        name: g.name,
        rank: g.rank,
        duration: stats.duration,
        ...(stats.cooldown ? { cooldown: stats.cooldown } : {}),
      });
    }
  }

  // --- skills -------------------------------------------------------------

  const attackRows = new Map<string, AttackRow>();
  for (const entry of save.skills) {
    const skill = db.getSkill(entry.record);
    if (!skill || entry.level < 1) continue;
    // A dual-wield-conditional skill is inert unless the loadout matches its
    // family — Dual Blades counts for a dual-wielder and contributes nothing
    // behind a shield, whatever band it would otherwise land in.
    const dwFamily = dualWieldFlag(skill, db);
    if (dwFamily && wielding.mode !== `dual-wield ${dwFamily}`) {
      excludedReasons.add('dualWield');
      continue;
    }
    const { band, reason } = classify(skill, db);
    if (band === 'rr') {
      collectRR(skill, db, ranks, entry.record, rrRows);
      continue;
    }
    if (band === 'attack') {
      // Attack damage still depends on what is being hit and stays out of the
      // global pools — but the skill's *types* are knowable, so type it. The
      // same records carry on-hit RR, which the band routing would otherwise
      // silently lose (attack skills never reach the fold above).
      collectAttackDamage(skill, db, ranks, entry, attackRows, rrRows);
      continue;
    }
    if (band === 'excluded') {
      if (reason) excludedReasons.add(reason);
      continue;
    }

    const stats = statRecord(skill, db);
    const rank = ranks.get(entry.record)?.effective ?? entry.level;
    const name = skillLabel(skill, db);
    fold('Skill', name, 'skill', band, stats.stats, atRank(rank), `rank ${rank}`, undefined, {
      rank,
      record: entry.record,
    });
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

  // Attribute totals: the save's value is the engine's base (starting 50 plus
  // allocated points); everything the fold collected sits on top, and the
  // percent modifiers multiply the sum of both.
  const attribute = (key: AttrKey): AttributeTotal => {
    const base = save.attributes[key];
    const flat = attrSums.flat[key];
    const percent = attrSums.percent[key];
    return { base, flat, percent, total: (base + flat) * (1 + percent / 100) };
  };
  const attributes: AttributeSummary = {
    physique: attribute('physique'),
    cunning: attribute('cunning'),
    spirit: attribute('spirit'),
    offensiveAbility: { flat: attrSums.oaFlat, percent: attrSums.oaPercent },
    defensiveAbility: { flat: attrSums.daFlat, percent: attrSums.daPercent },
    unspentPoints: save.attributes.attributePoints,
  };

  // Every equipped item re-checked against the finished totals. The character
  // is wearing it all, so this is a model invariant, not a finding — but the
  // per-item `effective` numbers are exactly what a swap candidate compares to.
  const standing = {
    level: save.level,
    attributes: Object.fromEntries(ATTR_KEYS.map((key) => [key, attributes[key].total])) as Record<
      AttrKey,
      number
    >,
    reductions,
  };
  const equippedRequirements = slots.map(({ slot, item }) => ({
    slot,
    item: item.display,
    check: checkRequirements(item, standing),
  }));

  return {
    name: save.name,
    level: save.level,
    difficulty,
    weaponSet: save.alternateWeaponSetActive ? 2 : 1,
    wielding,
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
    damage: damageProfile(damage, conversionRows, attackRows, rrRows, ranks, save, db),
    defense: defenseSummary(defense, armorPieces, slots, db.armorAbsorptionBase(), db.combatFormulas().hitChances, leechSources),
    speed: speedSummary(speedPermanent, speedMaintainable, slots, db),
    ranks: [...ranks.values()].sort((a, b) => b.invested - a.invested),
    maintained,
    grantedSkills,
    skillModifiers: skillModifiers(slots, db),
    attributes,
    requirementReductions: reductions,
    equippedRequirements,
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
  into: ResistReductionRow[],
): void {
  const stats = statRecord(skill, db);
  const rank = ranks.get(record)?.effective ?? 1;
  collectResistReduction(stats.stats, atRank(rank), skillLabel(skill, db), into, {
    rank,
    record,
    negativeDefensiveIsRR: true,
  });
}

/** Interim per-attack-skill accumulator; finalized into `SkillDamage` rows. */
interface AttackRow {
  label: string;
  record: string;
  rank: number;
  invested: number;
  weaponDamagePct: number;
  flat: Partial<Record<DamageKey, number>>;
  ownPercent: Partial<Record<DamageKey, number>>;
  ownTotalPercent: number;
  conversions: Conversion[];
  isDefaultAttack: boolean;
  lifeLeechPercent: number;
}

/**
 * Type what an invested attack skill deals: its own flat damage at rank, how
 * much of the weapon it inherits, and the conversions scoped to it. Modifier
 * and transmuter nodes fold into the skill they modify — their conversion is
 * the classic transmuter mechanic ("this skill's damage becomes aether"), and
 * attributing it anywhere else would turn it global, which it is not.
 */
function collectAttackDamage(
  skill: DbSkill,
  db: GameDb,
  ranks: Map<string, EffectiveRank>,
  entry: { record: string; level: number },
  into: Map<string, AttackRow>,
  rrRows: ResistReductionRow[],
): void {
  const stats = statRecord(skill, db);
  const rank = ranks.get(entry.record)?.effective ?? entry.level;
  const read = atRank(rank);

  let key = entry.record;
  let label = skillLabel(skill, db);
  let isModifierNode = false;
  if (stats.class === 'Skill_Modifier' || stats.class === 'Skill_Transmuter') {
    const parent = modifierParent(entry.record, db);
    if (parent) {
      key = parent.record;
      label = skillLabel(parent, db);
      isModifierNode = true;
    }
  }

  const row = into.get(key) ?? {
    label,
    record: key,
    rank: 0,
    invested: 0,
    weaponDamagePct: 0,
    flat: {},
    ownPercent: {},
    ownTotalPercent: 0,
    conversions: [],
    isDefaultAttack: false,
    lifeLeechPercent: 0,
  };
  row.invested += entry.level;
  if (!isModifierNode) {
    row.label = label;
    row.rank = rank;
    row.isDefaultAttack = stats.class.startsWith('Skill_WeaponPool_');
  }
  row.weaponDamagePct += read(stats.stats['weaponDamagePct'] ?? 0);
  const own = addDamage(emptyDamage(), stats.stats, read);
  for (const [dmgKey, amount] of Object.entries(own.flat) as [DamageKey, number][]) {
    if (amount) row.flat[dmgKey] = (row.flat[dmgKey] ?? 0) + amount;
  }
  // The skill's own `+%` scales this skill alone; it lands on the row, never in
  // the global pools.
  for (const [dmgKey, amount] of Object.entries(own.percent) as [DamageKey, number][]) {
    if (amount) row.ownPercent[dmgKey] = (row.ownPercent[dmgKey] ?? 0) + amount;
  }
  row.ownTotalPercent += own.totalPercent;
  // A skill's own leech applies to that skill's whole damage — the one case
  // where attack-damage-to-health is not about the weapon share — and it
  // scopes to the skill, so it never joins the global `defense` figure.
  row.lifeLeechPercent += read(stats.stats['offensiveLifeLeechMin'] ?? 0);
  row.conversions.push(...conversions(stats.stats, read));
  // On-hit RR carried on the attack skill's record (or its modifier node) —
  // this branch is its only reader, since attack skills never reach the fold.
  collectResistReduction(stats.stats, read, label, rrRows, {
    rank,
    record: entry.record,
    negativeDefensiveIsRR: true,
  });
  into.set(key, row);
}

const DAMAGE_TYPE_BY_KEY = new Map(DAMAGE_TYPES.map((t) => [t.key, t]));

function damageProfile(
  damage: DamageContribution,
  conversionRows: ScopedConversion[],
  attackRows: Map<string, AttackRow>,
  rrRows: ResistReductionRow[],
  ranks: Map<string, EffectiveRank>,
  save: CharacterSave,
  db: GameDb,
): DamageProfile {
  // The pools were collected pre-conversion; what the character deals is the
  // post-conversion distribution. Only permanent global conversions apply —
  // a maintainable buff's conversion is listed but not folded, same rule as
  // its resistances.
  const flat = applyConversions(
    damage.flat,
    conversionRows.filter((c) => c.scope === 'global'),
  );

  const ranked: DamageEntry[] = DAMAGE_TYPES.map((type) => ({
    key: type.key,
    label: type.label,
    percent: Math.round(damage.percent[type.key] ?? 0),
    flat: Math.round(flat[type.key] ?? 0),
    overTime: type.overTime,
  }))
    .filter((entry) => entry.percent > 0 || entry.flat > 0)
    // Percent modifiers are what a build commits to; flat damage breaks ties.
    .sort((a, b) => b.percent - a.percent || b.flat - a.flat);

  // The basic attack's payload: every flat pool lands there (and only there,
  // unless a skill carries % weapon damage), so shares of the converted pools
  // are exactly its composition.
  const flatTotal = Object.values(flat).reduce((n, v) => n + v, 0);
  const composition = (Object.entries(flat) as [DamageKey, number][])
    .filter(([, amount]) => amount > 0.5)
    .map(([dmgKey, amount]) => ({
      key: dmgKey,
      label: DAMAGE_TYPE_BY_KEY.get(dmgKey)?.label ?? dmgKey,
      share: Math.round((amount / flatTotal) * 100),
      overTime: DAMAGE_TYPE_BY_KEY.get(dmgKey)?.overTime ?? false,
    }))
    .sort((a, b) => b.share - a.share);
  const replacer = [...attackRows.values()].find((row) => row.isDefaultAttack);
  const weaponAttack: WeaponAttackSummary = {
    composition,
    ...(replacer ? { mainAttack: replacer.label } : {}),
  };

  const skillDamage: SkillDamage[] = [...attackRows.values()]
    .sort((a, b) => b.invested - a.invested)
    .map((row) => ({
      skill: row.label,
      record: row.record,
      rank: row.rank || 1,
      ...(row.weaponDamagePct ? { weaponDamagePct: Math.round(row.weaponDamagePct) } : {}),
      ...(row.lifeLeechPercent ? { lifeLeechPercent: Math.round(row.lifeLeechPercent * 10) / 10 } : {}),
      flat: (Object.entries(row.flat) as [DamageKey, number][])
        .map(([dmgKey, amount]) => ({
          key: dmgKey,
          label: DAMAGE_TYPE_BY_KEY.get(dmgKey)?.label ?? dmgKey,
          amount: Math.round(amount),
          overTime: DAMAGE_TYPE_BY_KEY.get(dmgKey)?.overTime ?? false,
        }))
        .filter((f) => f.amount > 0)
        .sort((a, b) => b.amount - a.amount),
      ownPercent: (Object.entries(row.ownPercent) as [DamageKey, number][])
        .map(([dmgKey, percent]) => ({
          key: dmgKey,
          label: DAMAGE_TYPE_BY_KEY.get(dmgKey)?.label ?? dmgKey,
          percent: Math.round(percent),
          overTime: DAMAGE_TYPE_BY_KEY.get(dmgKey)?.overTime ?? false,
        }))
        .filter((f) => f.percent !== 0)
        .sort((a, b) => b.percent - a.percent),
      ...(Math.round(row.ownTotalPercent) ? { ownTotalPercent: Math.round(row.ownTotalPercent) } : {}),
      conversions: row.conversions,
      isDefaultAttack: row.isDefaultAttack,
    }));

  const weaponRestrictions: DamageProfile['weaponRestrictions'] = [];
  for (const entry of save.skills) {
    if (entry.level < 1) continue;
    const skill = db.getSkill(entry.record);
    if (!skill?.weapons?.length) continue;
    weaponRestrictions.push({ skill: skillLabel(skill, db), weapons: skill.weapons });
  }

  // Category order mirrors the stacking story: what stacks first, then the
  // two only-strongest-applies groups, then the adjacent debuffs.
  const categoryOrder: Record<string, number> = { percent: 0, flat: 1, percentReduced: 2, other: 3 };
  const resistReduction = [...rrRows].sort(
    (a, b) => (categoryOrder[a.category] ?? 9) - (categoryOrder[b.category] ?? 9) || b.value - a.value,
  );

  // The payload index, off the unrounded pools. Kept to one decision: every
  // positive post-conversion flat pool times its own accumulated `+%` column
  // (plus the `+% Total Damage` that scales all of them).
  let payloadIndex = 0;
  for (const [dmgKey, amount] of Object.entries(flat) as [DamageKey, number][]) {
    if (amount > 0) payloadIndex += amount * (1 + ((damage.percent[dmgKey] ?? 0) + damage.totalPercent) / 100);
  }

  return {
    ranked,
    totalDamagePercent: Math.round(damage.totalPercent),
    payloadIndex: Math.round(payloadIndex),
    conversions: conversionRows,
    weaponAttack,
    skillDamage,
    resistReduction,
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
  hitChances: Record<string, number>,
  lifeLeechSources: DefenseSummary['lifeLeechSources'],
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
      // From the combat manager record, not the constant: the shipped weights
      // (Head 15, Shoulders 15, Chest 26, Hands 12, Legs 20, Feet 12) differ
      // from the community table this tool once hardcoded.
      hitChance: hitChances[part.slot] ?? part.hitChance,
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
    lifeLeechSources,
  };
}

// ---------------------------------------------------------------------------
// Speed
// ---------------------------------------------------------------------------

/** Weapon classes whose `characterBaseAttackSpeed` is a real swing rate. */
const WEAPON_CLASS = /^Weapon(Melee|Hunting|Magical)_/;

/**
 * A held weapon's own base rate.
 *
 * `characterBaseAttackSpeed` is an *additive delta in attacks per second* — Very
 * Fast is about −0.02, Very Slow about −0.20 — so the weapon's unbuffed rate is
 * the engine baseline plus it, and it is never a percentage. Off-hands and
 * shields carry the descriptor tag as template filler with no number, so they
 * are skipped: only records matching `WEAPON_CLASS` have one.
 */
function weaponSpeeds(slots: EquippedSlot[], base: number, db: GameDb): WeaponSpeed[] {
  const out: WeaponSpeed[] = [];
  for (const { slot, item } of slots) {
    const weapon = item.base;
    if (!weapon || !WEAPON_CLASS.test(weapon.slot)) continue;
    const raw = weapon.stats['characterBaseAttackSpeed'];
    const delta = typeof raw === 'number' ? raw : 0;
    const tagRaw = weapon.stats['characterBaseAttackSpeedTag'];
    const tag =
      typeof tagRaw === 'string'
        ? db.localize(tagRaw).replace(/^speed:\s*/i, '').replace(/^(tag)?(Character)?AttackSpeed/i, '').trim()
        : '';
    out.push({ slot, item: weapon.name, tag, delta, aps: base + delta });
  }
  return out;
}

/**
 * Resolve one speed channel against its cap.
 *
 * The cap applies to the *resulting* percentage, not to the modifier sum, which
 * is the whole mechanism behind the game's "slower weapons gain less from %
 * Attack Speed bonuses": a weapon starting at 82% of baseline needs 147 points
 * of `+%` to reach 200% where one starting at 98% needs 102.
 */
function speedLine(
  label: string,
  base: number,
  weaponBase: number,
  weaponNote: string | undefined,
  permanentPercent: number,
  maintainablePercent: number,
  cap: number,
): SpeedLine {
  const ratio = base > 0 ? weaponBase / base : 1;
  const raw = (pct: number): number => 100 * ratio * (1 + pct / 100);
  const rawPercent = raw(permanentPercent);
  const rawWith = raw(permanentPercent + maintainablePercent);
  const percent = Math.min(rawPercent, cap);
  const percentWith = Math.min(rawWith, cap);
  // Headroom is in modifier points, because that is the unit an affix is sold
  // in: how much more `+% Attack Speed` this character can still use.
  const headroom = ratio > 0 ? Math.max(0, (cap - rawWith) / ratio) : 0;

  return {
    label,
    base,
    weaponBase,
    ...(weaponNote ? { weaponNote } : {}),
    permanentPercent,
    maintainablePercent,
    cap,
    percent,
    percentWithMaintainable: percentWith,
    rawPercent,
    rawPercentWithMaintainable: rawWith,
    rate: (base * percent) / 100,
    rateWithMaintainable: (base * percentWith) / 100,
    headroom,
  };
}

function speedSummary(
  permanent: SpeedFields,
  maintainable: SpeedFields,
  slots: EquippedSlot[],
  db: GameDb,
): SpeedSummary {
  const base = db.baseSpeeds();
  const caps = db.speedCaps();
  const weapons = weaponSpeeds(slots, base.attack, db);

  // Dual wielding weights each weapon at `dwWeaponSpeedFactor`, so two weapons
  // give their mean. One weapon (or none) is simply its own rate.
  let attackBase = base.attack;
  let note: string | undefined;
  if (weapons.length === 1) {
    attackBase = weapons[0]!.aps;
    note = `${weapons[0]!.item}${weapons[0]!.tag ? ` (${weapons[0]!.tag.toLowerCase()})` : ''}`;
  } else if (weapons.length > 1) {
    attackBase = weapons.reduce((n, w) => n + w.aps * base.dualWieldFactor, 0);
    note =
      `mean of ${weapons.map((w) => `${w.item}${w.tag ? ` ${w.tag.toLowerCase()}` : ''}`).join(' + ')}` +
      ` (dwWeaponSpeedFactor ${base.dualWieldFactor})`;
  } else {
    note = 'unarmed';
  }

  return {
    attack: speedLine(
      'Attack',
      base.attack,
      attackBase,
      note,
      permanent.attackPercent + permanent.totalPercent,
      maintainable.attackPercent + maintainable.totalPercent,
      caps.attack + permanent.attackCapPercent + maintainable.attackCapPercent,
    ),
    cast: speedLine(
      'Casting',
      base.cast,
      base.cast,
      undefined,
      permanent.castPercent + permanent.totalPercent,
      maintainable.castPercent + maintainable.totalPercent,
      caps.cast,
    ),
    movement: speedLine(
      'Movement',
      base.run,
      base.run,
      undefined,
      permanent.runPercent + permanent.totalPercent,
      maintainable.runPercent + maintainable.totalPercent,
      caps.run + permanent.runCapPercent + maintainable.runCapPercent,
    ),
    weapons,
    totalSpeedPercent: { permanent: permanent.totalPercent, maintainable: maintainable.totalPercent },
  };
}

/** A skill an equipped part grants outright, located on the part that carries it. */
interface GrantedSkillRef {
  slot: string;
  /** The part the grant rides on — a component's skill leaves with the component. */
  part: string;
  record: string;
  name: string;
  /** The rank the item grants it at (`itemSkillLevel`); 1 unless the record says otherwise. */
  rank: number;
}

/** The two fields an item states a grant with, as `statfmt` reads them. */
const GRANT_FIELDS = ['itemSkillName', 'skillName'] as const;

/**
 * Every skill the loadout grants, by the part granting it.
 *
 * Read off the stat blocks rather than from `DbItem.grantedSkill`, which is
 * set only when the *activator* record has a name of its own — and a toggled
 * aura's name lives on the buff it points at, so `grantedSkill` is undefined
 * for exactly the kind that matters most. `skillLabel` follows that hop.
 */
function grantedSkillRefs(slots: EquippedSlot[], db: GameDb): GrantedSkillRef[] {
  const out: GrantedSkillRef[] = [];
  for (const { slot, item } of slots) {
    const parts: [string, { stats: Record<string, StatValue>; grantedSkill?: { record: string } } | undefined][] = [
      [item.base?.name ?? item.record, item.base],
      [item.prefixName ?? 'prefix', item.prefix],
      [item.suffixName ?? 'suffix', item.suffix],
      [item.modifierName ?? 'crafting bonus', item.modifier],
      ['completion bonus', item.completion],
      [item.component?.name ?? 'component', item.component],
      [item.augment?.name ?? 'augment', item.augment],
    ];
    for (const [partName, part] of parts) {
      if (!part) continue;
      // The stat fields are the authority — `grantedSkill` is a build-time
      // convenience that goes missing on exactly the toggled auras — but read
      // both, so a part carrying only the indexed form is still seen.
      const records = new Set<string>();
      for (const field of GRANT_FIELDS) {
        const value = part.stats[field];
        if (typeof value === 'string' && value) records.add(value);
      }
      if (part.grantedSkill?.record) records.add(part.grantedSkill.record);
      for (const record of records) {
        const skill = db.getSkill(record);
        if (!skill) continue;
        const level = part.stats['itemSkillLevel'];
        out.push({
          slot,
          part: partName,
          record,
          name: skillLabel(skill, db),
          rank: typeof level === 'number' && level > 0 ? level : 1,
        });
      }
    }
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
    // Item-granted passives and toggles *are* counted now, on their own rows —
    // so what is left out here is only the conditional kinds.
    'item-granted procs, activated skills and pet skills (named above, stats not summed — an always-on passive or toggle is counted, on its own row)',
    'item skill modifiers (named above, stats not summed)',
    'attack and retaliation damage, which depend on what is being hit',
    'permanent global conversions are folded into the flat damage figures; skill-scoped conversion is listed on the skill it converts and folded nowhere',
    'flat damage figures are min–max midpoints, and gear flat damage reaches skills only through their % weapon damage — the weapon-attack composition is what it describes',
    'affix values are the record’s base numbers; the engine rolls each within its jitter',
    // The resistance matrix bands maintainable buffs separately; everything
    // else here is a permanent-sources sum, and saying so beats letting a
    // reader assume the buff's damage bonus is already in the ranking.
    'the damage profile, armour, non-damage resistances, and attribute totals count permanent sources only — maintainable buffs add to the resistance bands and nothing else',
    'OA/DA figures are gear-and-skill contributions; the level- and attribute-derived engine base is not modelled',
    'requirement checks describe the character as currently dressed — a reduction or +attribute lost with an outgoing item changes what the incoming one needs',
    'a gear swap that changes +skills shifts every rank below, and with it the skill rows above; these numbers are the current loadout’s',
  );
  return [...new Set(out)].sort();
}

/** Column order for anything rendering the matrix. */
export const RESIST_ORDER: readonly ResistKey[] = RESIST_COLUMNS.map((c) => c.key);
