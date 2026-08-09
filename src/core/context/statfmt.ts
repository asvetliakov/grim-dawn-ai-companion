/**
 * Turning raw DBR stat keys into the lines a player reads in game.
 *
 * The aggregates in `src/core/mechanics/` only care about the handful of fields
 * that feed a total. The context document has the opposite job: it must render
 * *everything* an item carries, because the advisor is comparing whole items and
 * a dropped line is a stat it will never know about. So the rule here is that an
 * unrecognised key falls back to `` `key: value` `` rather than disappearing —
 * the only keys that vanish are the ones on the explicit plumbing list below
 * (mesh names, ragdoll physics, quest wiring), which are not stats at all.
 *
 * Three conventions from the data are worth restating, because the templates
 * lean on them: `defensive<Type>` is a percentage resistance, `character*` is
 * mostly flat, and a `Modifier` suffix always means percent. Flat damage comes
 * as a `Min`/`Max` pair, and a lone `Min` means the value is fixed.
 */

import type { GameDb, StatValue } from '../db/types.js';
import { atRank } from '../mechanics/skills.js';
import {
  conversions,
  DAMAGE_TYPES,
  RESIST_COLUMNS,
  SECONDARY_RESIST_FIELDS,
} from '../mechanics/stats.js';

export interface StatContext {
  db: GameDb;
  /** Reads a possibly-per-rank value; defaults to "scalars only". */
  read?: (value: StatValue) => number;
  /**
   * Skill records the character has points in. An item's `modifierSkillName<N>`
   * record is expanded inline only when the modified skill is one of these —
   * that is when its numbers are real value rather than a hypothetical.
   */
  invested?: ReadonlySet<string>;
  /** False inside an expansion, so a modifier cannot expand another modifier. */
  expandModifiers?: boolean;
}

const SCALAR = (value: StatValue): number => (typeof value === 'number' ? value : 0);

/** One decimal at most; whole numbers stay whole. */
export function num(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function signed(value: number): string {
  return value < 0 ? num(value) : `+${num(value)}`;
}

function range(min: number, max: number | undefined): string {
  return max === undefined || Math.abs(max - min) < 0.05 ? num(min) : `${num(min)}–${num(max)}`;
}

// ---------------------------------------------------------------------------
// What is not a stat
// ---------------------------------------------------------------------------

/**
 * Engine plumbing: art, physics, sound, quest wiring, and the fields other parts
 * of the document render themselves (recipe reagents in §10, weapon whitelists
 * and skill metadata on the skill rows). Everything here is dropped silently;
 * anything else that is unrecognised still prints as `key: value`.
 */
const PLUMBING = new Set([
  'templateName',
  'Class',
  'ActorName',
  'FileDescription',
  'itemLevel',
  'itemCost',
  'itemNameTag',
  'itemText',
  'itemStyleTag',
  'itemQualityTag',
  'itemClassification',
  'itemSetName',
  'armorClassification',
  'attributeScalePercent',
  'bonusTableName',
  'completedRelicLevel',
  'forcedRelicCompletion',
  'craftingMaterial',
  'maxStackSize',
  'medalVisible',
  'preventEasyDrops',
  'showQuestItemTag',
  'requiredQuestFile',
  'requiredTaskUID',
  'subHeading',
  'noteWidth',
  'type',
  'useDelayTime',
  'expansionTime',
  'maxMoveRatio',
  'targetingMode',
  'targetFxFirstOnly',
  'instantCast',
  'debufSkill',
  'exclusiveSkill',
  'overwriteBaseSkill',
  'specialSecondaryActivation',
  'leftHandWeaponDisplay',
  'pointBlank',
  'skillAllowsWarmUp',
  'warmUpEffectAttachPoint',
  'skillDependancy',
  'skillExperienceLevels',
  'skillChanceWeight',
  'skillDisplayName',
  'skillBaseDescription',
  'buffSkillName',
  'petSkillName',
  'skillMaxLevel',
  'skillUltimateLevel',
  'skillTier',
  'MasteryEnumeration',
  'skillActivatedAuraName',
  'skillProjectileName',
  'charBuffFxType',
  'projectileUsesAllDamage',
  'projectileLaunchRotation',
  'blockRecoveryTime',
  'blockAbsorption',
  'characterBaseAttackSpeed',
  'skillTargetAngle',
  'skillComboChargeLevel',
  'skillComboChargeDuration',
  'skillLifePercentBuffDuration',
  'skillProjectileNumber',
  'thresholdDuration',
  'attachPointName',
  // The faction an augment is sold by; §9 renders vendor and price properly.
  'factionSource',
  // Every augment is soulbound; §2 states the rule once instead of 300 times.
  'soulbound',
  // Weapon attack speed is a class tag, rendered on the item's own header line
  // where it means something — on a chestpiece the field is template filler.
  'characterBaseAttackSpeedTag',
  'artifactName',
  'artifactClassification',
  'artifactCreateQuantity',
  'artifactCreationCost',
  'reagentBaseBaseName',
  'reagentBaseQuantity',
  'forcedRandomArtifactName',
  // Damage-over-time bookkeeping flags, not numbers the player sees.
  'offensiveSlowBleedingGlobal',
  'offensiveSlowBleedingXOR',
  'offensiveSlowPhysicalGlobal',
  'offensiveSlowPhysicalXOR',
]);

const PLUMBING_PATTERNS: readonly RegExp[] = [
  /^(physics|ragDoll|marker|wave|mesh|shader|sound|spawn)/i,
  /^(questFile|taskUID|reagent\d)/,
  /^projectileDamageRange/,
  // Weapon-type whitelist flags on a skill record; the skill row prints them.
  /^(Sword|Axe|Mace|Dagger|Scepter|Spear|Ranged)(1h|2h)?$/,
  /^(Shield|Offhand)$/,
];

function isPlumbing(field: string): boolean {
  return PLUMBING.has(field) || PLUMBING_PATTERNS.some((re) => re.test(field));
}

// ---------------------------------------------------------------------------
// Single-key templates
// ---------------------------------------------------------------------------

/** `{v}` is the signed value, `{u}` the unsigned one. */
const TEMPLATES: Readonly<Record<string, string>> = {
  // Attributes and abilities
  characterStrength: '{v} Physique',
  characterStrengthModifier: '{v}% Physique',
  characterDexterity: '{v} Cunning',
  characterDexterityModifier: '{v}% Cunning',
  characterIntelligence: '{v} Spirit',
  characterIntelligenceModifier: '{v}% Spirit',
  characterOffensiveAbility: '{v} Offensive Ability',
  characterOffensiveAbilityModifier: '{v}% Offensive Ability',
  characterDefensiveAbility: '{v} Defensive Ability',
  characterDefensiveAbilityModifier: '{v}% Defensive Ability',
  characterConstitutionModifier: '{v}% Constitution',
  // Vitals
  characterLife: '{v} Health',
  characterLifeModifier: '{v}% Health',
  characterLifeRegen: '{v} Health Regenerated per second',
  characterLifeRegenModifier: '{v}% Health Regeneration',
  characterMana: '{v} Energy',
  characterManaModifier: '{v}% Energy',
  characterManaRegen: '{v} Energy Regenerated per second',
  characterManaRegenModifier: '{v}% Energy Regeneration',
  characterManaLimitReserve: '{u}% Energy Reserved',
  characterManaLimitReserveReduction: '-{u}% Energy Reserved',
  characterEnergyAbsorptionPercent: '{v}% Energy Absorbed from Spells',
  characterHealIncreasePercent: '{v}% Increase to All Healing',
  // Speeds
  characterAttackSpeedModifier: '{v}% Attack Speed',
  characterSpellCastSpeedModifier: '{v}% Casting Speed',
  characterRunSpeedModifier: '{v}% Movement Speed',
  characterRunSpeedMaxModifier: '{v}% Maximum Movement Speed',
  characterTotalSpeedModifier: '{v}% Total Speed',
  // Avoidance
  characterDodgePercent: '{v}% Chance to Avoid Melee Attacks',
  characterDeflectProjectile: '{v}% Chance to Avoid Projectiles',
  characterIncreasedExperience: '{v}% Experience Gained',
  // Skill economy
  skillCooldownReduction: '-{u}% Skill Cooldowns',
  skillManaCostReduction: '-{u}% Skill Energy Cost',
  skillComboChargeSpendReduction: '-{u}% Charge Spend',
  cooldownCharges: '{u} charges',
  // Armour and blocking
  defensiveProtection: '{u} Armor',
  defensiveBonusProtection: '{v} Armor to every body part',
  defensiveProtectionModifier: '{v}% Armor',
  defensiveAbsorptionModifier: '{v}% Armor Absorption (multiplies the 70% base)',
  defensiveBlock: '{u} Blocked Damage',
  defensiveBlockChance: '{u}% Chance to Block',
  defensiveBlockModifier: '{v}% Shield Damage Blocked',
  defensiveBlockAmountModifier: '{v}% Shield Damage Blocked',
  characterDefensiveBlockRecoveryReduction: '-{u}% Shield Recovery Time',
  damageAbsorptionPercent: '{u}% Damage Absorption',
  // Offence that is not a damage type
  offensiveTotalDamageModifier: '{v}% Total Damage',
  offensiveCritDamageModifier: '{v}% Crit Damage',
  offensiveLifeLeechMin: '{u}% of Attack Damage converted to Health',
  offensivePierceRatioMin: '{u}% Armor Piercing',
  offensiveDamageMultModifier: '{v}% Damage Multiplier',
  retaliationTotalDamageModifier: '{v}% Total Retaliation Damage',
  projectilePiercingChance: '{u}% Chance to Pass Through Enemies',
  projectileLaunchNumber: 'fires {u} projectiles',
  // Enemy-facing effects with no Chance/Duration qualifier of their own.
  offensiveTotalResistanceReductionAbsoluteMin: '-{u} to All Enemy Resistances',
  offensiveSlowDefensiveReductionMin: '-{u}% Reduced Target Resistances',
  offensivePhysicalResistanceReductionPercentMin: '-{u}% Enemy Physical Resistance',
  offensiveFumbleMin: '{u}% Chance of Enemy Fumble',
  // Skill payloads worth seeing on a skill row
  weaponDamagePct: '{u}% Weapon Damage',
  skillLifePercent: 'heals {u}% of Health',
  skillLifeBonus: 'heals {u} Health',
  skillTargetRadius: '{u}m radius',
  skillTargetNumber: 'hits up to {u} target(s)',
  skillManaCost: '{u} Energy per cast',
  onHitActivationChance: '{u}% chance to trigger on hit',
  lifeMonitorPercent: 'triggers below {u}% Health',
  petBonusName: 'grants a pet bonus (pet stats are out of scope for this tool)',
  // Flags
  untradeable: 'untradeable',
  dualWieldOnly: 'requires dual-wielded melee weapons',
  dualRangedOnly: 'requires dual-wielded ranged weapons',
};

/** Where a rendered line belongs, so the output reads in a stable order. */
const enum Bucket {
  Damage = 0,
  Conversion = 1,
  Resistance = 2,
  Defense = 3,
  Character = 4,
  Skills = 5,
  Other = 6,
  Raw = 7,
}

interface Line {
  bucket: Bucket;
  text: string;
}

// ---------------------------------------------------------------------------
// Lookup tables built from the mechanics vocabulary
// ---------------------------------------------------------------------------

const RESIST_BY_FIELD = new Map(RESIST_COLUMNS.map((c) => [c.field, c.label]));
const DAMAGE_BY_STEM = new Map(DAMAGE_TYPES.map((t) => [t.stem, t]));

/** `+% Maximum <X> Resistance` — the field that lifts the 80 cap. */
const MAX_RESIST = /^defensive(.+)MaxResist$/;
/** `+% <crowd control> Duration`, for the effects that are not damage types. */
const CC_DURATION =
  /^offensive(Stun|Freeze|Petrify|Trap|Sleep|Confusion|Fear|Taunt|Knockdown|Convert|Disruption)Modifier$/;
/** The `-% Requirement` matrix: scope × attribute. */
const REQ_REDUCTION =
  /^character(Global|Armor|Jewelry|Shield|Weapon2H|Weapon|Melee|Hunting|Staff)(Strength|Dexterity|Intelligence)?ReqReduction$/;

const REQ_ATTR: Readonly<Record<string, string>> = {
  Strength: 'Physique',
  Dexterity: 'Cunning',
  Intelligence: 'Spirit',
};

const REQ_SCOPE: Readonly<Record<string, string>> = {
  Global: 'all items',
  Armor: 'armor',
  Jewelry: 'jewelry',
  Shield: 'shields',
  Weapon: 'weapons',
  Weapon2H: 'two-handed weapons',
  Melee: 'melee weapons',
  Hunting: 'ranged weapons',
  Staff: 'staves',
};

/** `.../cast_@selfonattackcrit_33%.dbr` → "on your critical hit, 33% chance". */
const AUTOCAST_TRIGGERS: readonly [RegExp, string][] = [
  [/onattackcrit/, 'critical hit'],
  [/oncrit/, 'critical hit'],
  [/onattack/, 'attack'],
  [/onhit/, 'hit'],
  [/onblock/, 'block'],
  [/onkill/, 'kill'],
  [/onlowhealth/, 'low health'],
  [/ondeath/, 'death'],
];

function autoCastTrigger(record: string): string | undefined {
  const stem = record.split('/').pop()?.replace(/\.dbr$/, '') ?? '';
  const match = /^cast_@?(\w+?)_?(\d+%)?$/.exec(stem);
  if (!match) return undefined;
  const raw = match[1]!;
  const target = raw.startsWith('enemy') ? 'an enemy' : 'your';
  const event = AUTOCAST_TRIGGERS.find(([re]) => re.test(raw))?.[1];
  if (!event) return match[2] ? `${match[2]} chance` : undefined;
  return `on ${target} ${event}${match[2] ? `, ${match[2]} chance` : ''}`;
}

/**
 * What to call a skill record.
 *
 * A toggled aura, a shout and every item-granted proc are *two* records: a thin
 * activator carrying only `buffSkillName`, and the buff that holds the display
 * name. `veilofshadows1.dbr` — the record an item's `+2 to <skill>` actually
 * points at — has no name of its own, so a lookup that stops at `skillName`
 * renders a DBR path at the reader. Follow the hop, exactly as the aggregates do.
 */
export function skillDisplayName(db: GameDb, record: string): string {
  // Pet subtrees are deliberately not indexed (they are four fifths of the skill
  // data), so name them for what they are rather than printing a path.
  if (PET_SKILL.test(record)) return 'a pet skill *(pets are out of scope for this tool)*';
  const direct = db.skillName(record);
  if (direct) return direct;
  const skill = db.getSkill(record);
  if (skill?.name) return skill.name;
  const buff = skill?.buffRecord;
  if (buff) return db.getSkill(buff)?.name ?? db.skillName(buff) ?? record;
  return record;
}

const PET_SKILL = /\/pets\/|_petmodifier|petbonus/i;

// ---------------------------------------------------------------------------
// The formatter
// ---------------------------------------------------------------------------

/**
 * Render a stat block as display lines.
 *
 * The passes run in dependency order: paired families (flat damage min/max,
 * conversions, skill name/level pairs) claim their keys first, so the single-key
 * table and the raw fallback never see half of a pair.
 */
export function formatStats(stats: Record<string, StatValue>, ctx: StatContext): string[] {
  const read = ctx.read ?? SCALAR;
  const lines: Line[] = [];
  const used = new Set<string>();
  const add = (bucket: Bucket, text: string): void => {
    lines.push({ bucket, text });
  };
  const claim = (...fields: string[]): void => {
    for (const field of fields) used.add(field);
  };
  const value = (field: string): number | undefined => {
    const raw = stats[field];
    return raw === undefined ? undefined : read(raw);
  };

  damageLines(stats, read, add, claim, value);
  conversionLines(stats, read, add, claim);
  skillLines(stats, read, ctx, add, claim);

  for (const [field, raw] of Object.entries(stats)) {
    if (used.has(field) || isPlumbing(field)) continue;

    const template = TEMPLATES[field];
    if (template) {
      const v = read(raw);
      if (v === 0 && typeof raw !== 'string') continue;
      add(bucketOf(field), template.replace('{v}', signed(v)).replace('{u}', num(Math.abs(v))));
      continue;
    }

    const resist = RESIST_BY_FIELD.get(field);
    if (resist) {
      const v = read(raw);
      // Negative resistance on a player-facing record is resistance *reduction*
      // applied to enemies; the aggregates rely on the same rule.
      if (v < 0) add(Bucket.Damage, `-${num(-v)}% Enemy ${resist} Resistance`);
      else if (v > 0) add(Bucket.Resistance, `+${num(v)}% ${resist} Resistance`);
      continue;
    }
    if (field === 'defensiveElementalResistance') {
      add(Bucket.Resistance, `+${num(read(raw))}% Fire, Cold and Lightning Resistance`);
      continue;
    }
    if (field === 'defensiveAllResistance') {
      add(Bucket.Resistance, `+${num(read(raw))}% to All Resistances`);
      continue;
    }
    if (field === 'defensiveAllMaxResist') {
      add(Bucket.Resistance, `+${num(read(raw))}% to All Maximum Resistances`);
      continue;
    }
    const maxResist = MAX_RESIST.exec(field);
    if (maxResist) {
      const label = RESIST_BY_FIELD.get(`defensive${maxResist[1]}`);
      if (label) {
        add(Bucket.Resistance, `+${num(read(raw))}% Maximum ${label} Resistance`);
        continue;
      }
    }
    const secondary = SECONDARY_RESIST_FIELDS[field];
    if (secondary) {
      const suffix = /Duration$/.test(field) ? 'Duration Reduction' : 'Resistance';
      add(Bucket.Resistance, `+${num(read(raw))}% ${secondary} ${suffix}`);
      continue;
    }

    const reduction = REQ_REDUCTION.exec(field);
    if (reduction) {
      const v = read(raw);
      if (!v) continue;
      const attr = reduction[2] ? REQ_ATTR[reduction[2]] : 'all attribute';
      add(Bucket.Character, `-${num(v)}% ${attr} Requirement for ${REQ_SCOPE[reduction[1]!]}`);
      continue;
    }
    if (field === 'characterLevelReqReduction') {
      add(Bucket.Character, `-${num(read(raw))} Level Requirement`);
      continue;
    }
    if (field === 'racialBonusPercentDamage' || field === 'racialBonusAbsoluteDamage') {
      const races = raceNames(stats, ctx.db);
      const pct = field === 'racialBonusPercentDamage' ? '%' : '';
      add(Bucket.Damage, `+${num(read(raw))}${pct} Damage to ${races}`);
      claim('racialBonusRace');
      continue;
    }
    if (field === 'racialBonusPercentDefense') {
      add(Bucket.Resistance, `+${num(read(raw))}% Damage Resistance from ${raceNames(stats, ctx.db)}`);
      claim('racialBonusRace');
      continue;
    }
    if (field === 'racialBonusRace') continue;
    // `+% <crowd control> Duration`: the effects themselves are rendered as a
    // qualified min–max above, and only their duration scaling lands here.
    const ccDuration = CC_DURATION.exec(field);
    if (ccDuration) {
      add(Bucket.Damage, `${signed(read(raw))}% ${ccDuration[1]} Duration`);
      continue;
    }
    if (field === 'characterBaseAttackSpeedTag' && typeof raw === 'string') {
      add(Bucket.Character, `base attack speed: ${raw.replace(/^CharacterAttackSpeed/, '').toLowerCase()}`);
      continue;
    }

    if (typeof raw === 'string') {
      // A record path we have no template for says more as a name than a path.
      const name = raw.startsWith('records/')
        ? ctx.db.getItem(raw)?.name ?? (raw.includes('/skills/') ? skillDisplayName(ctx.db, raw) : undefined)
        : undefined;
      add(Bucket.Raw, `\`${field}: ${name ?? raw}\``);
      continue;
    }
    const v = read(raw);
    if (v !== 0) add(Bucket.Raw, `\`${field}: ${num(v)}\``);
  }

  return lines.sort((a, b) => a.bucket - b.bucket).map((l) => l.text);
}

function raceNames(stats: Record<string, StatValue>, db: GameDb): string {
  const raw = stats['racialBonusRace'];
  if (typeof raw !== 'string') return 'certain enemies';
  const names = raw
    .split(';')
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const localized = db.localize(`tag${token}`);
      return localized === `tag${token}` ? token : localized;
    });
  return names.length ? names.join(', ') : 'certain enemies';
}

function bucketOf(field: string): Bucket {
  if (field.startsWith('defensive') || field === 'damageAbsorptionPercent') return Bucket.Defense;
  if (field.startsWith('offensive') || field.startsWith('projectile')) return Bucket.Damage;
  if (field.startsWith('character')) return Bucket.Character;
  if (field.startsWith('skill') || field.startsWith('weaponDamage')) return Bucket.Skills;
  return Bucket.Other;
}

// ---------------------------------------------------------------------------
// Paired families
// ---------------------------------------------------------------------------

/**
 * Flat damage, `+%` damage, damage-over-time durations and retaliation, for all
 * sixteen types and the three flat spellings (`offensiveFireMin`,
 * `offensiveBaseFireMin`, `offensiveBonusPhysicalMin`).
 */
function damageLines(
  stats: Record<string, StatValue>,
  read: (v: StatValue) => number,
  add: (bucket: Bucket, text: string) => void,
  claim: (...fields: string[]) => void,
  value: (field: string) => number | undefined,
): void {
  const pair = (minField: string): { min: number; max: number | undefined } | undefined => {
    const min = value(minField);
    if (min === undefined) return undefined;
    const maxField = `${minField.slice(0, -3)}Max`;
    claim(minField, maxField);
    return { min, max: value(maxField) };
  };

  for (const type of DAMAGE_TYPES) {
    const { stem, label, overTime } = type;
    const duration = overTime ? value(`offensive${stem}DurationMin`) : undefined;
    if (overTime) claim(`offensive${stem}DurationMin`, `offensive${stem}DurationMax`);
    const over = duration ? ` over ${num(duration)} Seconds` : '';

    for (const prefix of ['offensive', 'offensiveBase', 'offensiveBonus']) {
      const flat = pair(`${prefix}${stem}Min`);
      if (!flat || (flat.min === 0 && !flat.max)) continue;
      const base = prefix === 'offensiveBase' ? '' : '+';
      add(Bucket.Damage, `${base}${range(flat.min, flat.max)} ${label} Damage${over}`);
    }

    const modifier = value(`offensive${stem}Modifier`);
    claim(`offensive${stem}Modifier`);
    if (modifier) add(Bucket.Damage, `${signed(modifier)}% ${label} Damage`);

    if (overTime) {
      const durationPct = value(`offensive${stem}DurationModifier`);
      claim(`offensive${stem}DurationModifier`);
      if (durationPct) add(Bucket.Damage, `${signed(durationPct)}% ${label} Duration`);
    }

    const chance = value(`offensive${stem}Chance`);
    claim(`offensive${stem}Chance`);
    if (chance) add(Bucket.Damage, `${num(chance)}% chance of ${label} Damage`);

    const retaliation = pair(`retaliation${stem}Min`);
    if (retaliation && (retaliation.min || retaliation.max)) {
      add(Bucket.Damage, `${range(retaliation.min, retaliation.max)} ${label} Retaliation Damage${over}`);
    }
    const retaliationPct = value(`retaliation${stem}Modifier`);
    claim(`retaliation${stem}Modifier`);
    if (retaliationPct) add(Bucket.Damage, `${signed(retaliationPct)}% ${label} Retaliation Damage`);
  }

  // Elemental is not a type of its own: flat splits three ways, `+%` boosts all
  // three (and none of their damage-over-time twins).
  const elemental = pair('offensiveElementalMin');
  if (elemental) {
    add(Bucket.Damage, `+${range(elemental.min, elemental.max)} Elemental Damage (a third each Fire, Cold, Lightning)`);
  }
  const elementalPct = value('offensiveElementalModifier');
  claim('offensiveElementalModifier');
  if (elementalPct) add(Bucket.Damage, `${signed(elementalPct)}% Fire, Cold and Lightning Damage`);

  // Effects whose `Min`/`Max` carries the number and whose sibling `Chance` and
  // `DurationMin` qualify it. Rendered as one line so the qualifiers cannot
  // float away from the number they belong to.
  for (const spec of QUALIFIED_EFFECTS) {
    const min = value(spec.min);
    const stem = spec.min.slice(0, -3);
    const chance = value(`${stem}Chance`);
    const duration = value(`${stem}DurationMin`);
    claim(spec.min, `${stem}Max`, `${stem}Chance`, `${stem}DurationMin`, `${stem}DurationMax`);
    if (!min) continue;
    const max = value(`${stem}Max`);
    const qualifiers = [
      duration ? `for ${num(duration)}s` : '',
      chance ? `${num(chance)}% chance` : '',
    ].filter(Boolean);
    const body = spec.text.replace('{r}', range(min, max));
    add(Bucket.Damage, `${body}${qualifiers.length ? ` (${qualifiers.join(', ')})` : ''}`);
  }
}

/** `{r}` is the min–max range; the sign is spelled out per entry. */
const QUALIFIED_EFFECTS: readonly { min: string; text: string }[] = [
  { min: 'offensiveSlowDefensiveAbilityMin', text: '-{r} Enemy Defensive Ability' },
  { min: 'offensiveSlowAttackSpeedMin', text: '-{r}% Enemy Attack Speed' },
  { min: 'offensiveSlowRunSpeedMin', text: '-{r}% Enemy Movement Speed' },
  { min: 'offensiveTotalResistanceReductionPercentMin', text: '-{r}% to All Enemy Resistances' },
  { min: 'offensiveTotalDamageReductionPercentMin', text: '-{r}% Enemy Damage' },
  { min: 'offensiveStunMin', text: '{r}s Stun' },
  { min: 'offensiveKnockdownMin', text: '{r}s Knockdown' },
  { min: 'offensiveFreezeMin', text: '{r}s Freeze' },
  { min: 'offensivePetrifyMin', text: '{r}s Petrify' },
  { min: 'offensiveSleepMin', text: '{r}s Sleep' },
  { min: 'offensiveTrapMin', text: '{r}s Entrapment' },
  { min: 'offensiveConfusionMin', text: '{r}s Confusion' },
  { min: 'offensiveFearMin', text: '{r}s Fear' },
  { min: 'offensiveTauntMin', text: '{r}s Taunt' },
  { min: 'offensiveConvertMin', text: '{r}s Enemy Conversion' },
  { min: 'offensiveDisruptionMin', text: '{r}s Skill Disruption' },
  { min: 'offensiveSlowOffensiveAbilityMin', text: '-{r} Enemy Offensive Ability' },
  { min: 'offensiveSlowOffensiveReductionMin', text: '-{r}% Enemy Damage dealt' },
  { min: 'offensivePercentCurrentLifeMin', text: '{r}% of the target’s current Health as damage' },
  { min: 'retaliationSlowManaLeachMin', text: '{r} Energy Leech Retaliation' },
  { min: 'retaliationSlowAttackSpeedMin', text: '-{r}% Enemy Attack Speed on retaliation' },
];

/** `{v}% {From} Damage converted to {To} Damage`, in the profile's own names. */
function conversionLines(
  stats: Record<string, StatValue>,
  read: (v: StatValue) => number,
  add: (bucket: Bucket, text: string) => void,
  claim: (...fields: string[]) => void,
): void {
  for (const suffix of ['', '2']) {
    claim(`conversionInType${suffix}`, `conversionOutType${suffix}`, `conversionPercentage${suffix}`);
  }
  for (const conversion of conversions(stats, read)) {
    add(
      Bucket.Conversion,
      `${num(conversion.percent)}% ${conversion.from} Damage converted to ${conversion.to} Damage`,
    );
  }
}

/**
 * The skill-reference families. Every one of them stores a record path beside a
 * level, so rendering them as paths (which is what the raw fallback would do)
 * would be the single most useless thing this module could print.
 */
/**
 * What a granted skill actually does, rendered inline at rank 1.
 *
 * `Grants: Empowered Impaling Weapons` on its own is a dead end — the buff's
 * `+flat pierce` is invisible to the reader, and item-granted skills are a
 * documented exclusion from the resistance totals, so nothing else in the
 * document supplies it either. Following the activator→buff hop here (the same
 * one toggled auras use) makes the numbers *visible* without summing them: the
 * matrix stays row-attributable, and the advisor stops having to guess.
 *
 * Recursion is cut off by `expandModifiers === false`, so a granted skill's own
 * granted skill is named but not expanded.
 */
/**
 * How a granted skill is *obtained*: always on, held on, cast, or rolled for.
 *
 * Without this the reader has to infer it — a toggle from an "Energy Reserved"
 * line, a passive from the absence of one — and the inference is wrong often
 * enough to matter. It changes what the stats mean: a passive's numbers are
 * simply true, a toggle's are true while it is held (at the energy cost the
 * stats already state), an activated skill's require a button, and a proc's are
 * a chance per hit. The classes come from the game's own template names.
 */
function grantedKind(record: string, trigger: string | undefined, ctx: StatContext): string {
  if (trigger) return `auto-cast ${trigger}`;
  const cls = ctx.db.skillClass(record) ?? ctx.db.getSkill(record)?.class ?? '';

  if (/Toggled/.test(cls)) return 'toggle — stays on until switched off';
  if (/^Skill_(WPAttack|WeaponPool)_/.test(cls)) return 'weapon-pool proc — a share of your basic attacks';
  if (/^Skill_PassiveOnLife/.test(cls)) return 'passive, triggers at low health';
  if (/^Skill_PassiveOnHit/.test(cls)) return 'passive, triggers when you are hit';
  if (/^(Skill|SkillBuff)_Passive/.test(cls)) return 'passive — always on';
  if (/SpawnPet|SpawnMiniPet/.test(cls)) return 'summons a pet';
  if (/^Skill_/.test(cls)) return 'activated — you have to cast it';
  return 'unknown activation';
}

function grantedDetail(record: string, ctx: StatContext): string {
  if (ctx.expandModifiers === false) return '';
  const skill = ctx.db.getSkill(record);
  const buff = skill?.buffRecord ? ctx.db.getSkill(skill.buffRecord) : undefined;
  const source = buff ?? skill;
  const lines = source ? formatStats(source.stats, { ...ctx, expandModifiers: false, read: atRank(1) }) : [];
  if (lines.length) return ` — ${lines.join('; ')}`;

  // Nothing to show is still worth saying: a bare "Grants: X" leaves the reader
  // unable to tell an unindexed record from a skill that genuinely does
  // nothing. Pet summons are the common case and are excluded on purpose.
  const cls = ctx.db.skillClass(record) ?? '';
  // The kind already said "summons a pet"; this only adds why there are no
  // numbers beside it.
  if (PET_SKILL.test(record) || /SpawnPet|SpawnMiniPet/.test(cls)) {
    return ' — *pet skill trees are out of scope for this tool*';
  }
  return ' — *stats not indexed for this skill*';
}

function skillLines(
  stats: Record<string, StatValue>,
  read: (v: StatValue) => number,
  ctx: StatContext,
  add: (bucket: Bucket, text: string) => void,
  claim: (...fields: string[]) => void,
): void {
  const name = (record: string): string => skillDisplayName(ctx.db, record);

  for (const [field, raw] of Object.entries(stats)) {
    if (typeof raw !== 'string') continue;

    const perSkill = /^augmentSkillName(\d*)$/.exec(field);
    if (perSkill) {
      const level = read(stats[`augmentSkillLevel${perSkill[1]}`] ?? 0);
      claim(field, `augmentSkillLevel${perSkill[1]}`);
      if (level) add(Bucket.Skills, `+${num(level)} to ${name(raw)}`);
      continue;
    }
    const perMastery = /^augmentMasteryName(\d*)$/.exec(field);
    if (perMastery) {
      const level = read(stats[`augmentMasteryLevel${perMastery[1]}`] ?? 0);
      claim(field, `augmentMasteryLevel${perMastery[1]}`);
      if (level) add(Bucket.Skills, `+${num(level)} to all skills in ${name(raw)}`);
      continue;
    }
    if (field === 'itemSkillName') {
      claim('itemSkillName', 'itemSkillLevel', 'itemSkillLevelEq', 'itemSkillAutoController');
      const controller = stats['itemSkillAutoController'];
      const trigger = typeof controller === 'string' ? autoCastTrigger(controller) : undefined;
      add(Bucket.Skills, `Grants: ${name(raw)} (${grantedKind(raw, trigger, ctx)})${grantedDetail(raw, ctx)}`);
      continue;
    }
    if (field === 'skillName') {
      claim('skillName');
      add(Bucket.Skills, `Grants: ${name(raw)} (${grantedKind(raw, undefined, ctx)})${grantedDetail(raw, ctx)}`);
      continue;
    }
    const modified = /^modifiedSkillName(\d*)$/.exec(field);
    if (modified) {
      const modifierField = `modifierSkillName${modified[1]}`;
      const modifier = stats[modifierField];
      claim(field, modifierField);
      const has = ctx.invested?.has(raw) ?? false;
      let detail = '';
      // An awakened item's real value is the modifier's numbers — but only when
      // the character actually has points in the skill being modified.
      if (has && ctx.expandModifiers !== false && typeof modifier === 'string') {
        const record = ctx.db.getSkill(modifier);
        if (record) {
          // Item-granted modifier records carry rank-1 tables, not scalars.
          const inner = formatStats(record.stats, { ...ctx, expandModifiers: false, read: atRank(1) });
          if (inner.length) detail = ` — ${inner.join('; ')}`;
        }
      }
      add(Bucket.Skills, `Modifies: ${name(raw)}${has ? '' : ' (no points invested)'}${detail}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Small renderers the document shares
// ---------------------------------------------------------------------------

/** The 23 use-on flags, in words. */
const SLOT_FLAG_NAMES: Readonly<Record<string, string>> = {
  head: 'head',
  shoulders: 'shoulders',
  chest: 'chest',
  hands: 'hands',
  legs: 'legs',
  feet: 'feet',
  waist: 'belt',
  amulet: 'amulet',
  ring: 'ring',
  medal: 'medal',
  offhand: 'caster off-hand',
  shield: 'shield',
  sword: '1h sword',
  sword2h: '2h sword',
  axe: '1h axe',
  axe2h: '2h axe',
  mace: '1h mace',
  mace2h: '2h mace',
  dagger: 'dagger',
  scepter: 'scepter',
  spear2h: 'spear',
  ranged1h: '1h ranged',
  ranged2h: '2h ranged',
};

/** Groups that collapse to one word when every member is present. */
const SLOT_SHORTHANDS: readonly { label: string; flags: readonly string[] }[] = [
  { label: 'any armor', flags: ['head', 'shoulders', 'chest', 'hands', 'legs', 'feet', 'waist'] },
  { label: 'any weapon', flags: ['sword', 'sword2h', 'axe', 'axe2h', 'mace', 'mace2h', 'dagger', 'scepter', 'spear2h', 'ranged1h', 'ranged2h'] },
  { label: 'any 1h melee', flags: ['sword', 'axe', 'mace', 'dagger', 'scepter'] },
  { label: 'any 2h melee', flags: ['sword2h', 'axe2h', 'mace2h', 'spear2h'] },
  { label: 'any jewelry', flags: ['amulet', 'ring', 'medal'] },
];

export function describeSlots(flags: readonly string[] | undefined): string {
  if (!flags?.length) return 'no slot restriction recorded';
  const remaining = new Set(flags);
  const parts: string[] = [];
  for (const group of SLOT_SHORTHANDS) {
    if (group.flags.every((f) => remaining.has(f))) {
      parts.push(group.label);
      for (const f of group.flags) remaining.delete(f);
    }
  }
  for (const flag of flags) {
    if (remaining.has(flag)) parts.push(SLOT_FLAG_NAMES[flag] ?? flag);
  }
  return parts.join(', ');
}
