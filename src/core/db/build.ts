/**
 * Turning raw `.arz` records plus a localization table into the normalized
 * database the rest of the tool consumes.
 *
 * The output is plain JSON: it gets cached as `db.json` so that after the first
 * run startup is a single file read with no archive parsing and no network.
 */

import { readFileSync } from 'node:fs';

import { num, readArz, str, strList, type ArzRecord, type ArzValue } from './arz.js';
import { evaluateFormula } from './formula.js';
import type { GameArchive } from './gamefiles.js';
import {
  REP_TIERS,
  type AttrRequirements,
  type DbAffix,
  type DbFaction,
  type DbItem,
  type DbReagent,
  type DbRecipe,
  type DbSet,
  type DbSkill,
  type RepTier,
  type SpeedCaps,
  type StatValue,
} from './types.js';

/** Bump when the shape below changes so stale caches rebuild instead of misreading. */
export const DB_SCHEMA_VERSION = 9;

export interface NormalizedDb {
  schemaVersion: number;
  gameVersion: string;
  /** The language `l10n` (and so every name in here) is in. */
  locale: string;
  /** Every language this install could be rebuilt in. */
  locales: string[];
  fingerprint: string;
  builtAt: string;
  archives: string[];
  items: Record<string, DbItem>;
  /**
   * Affix record path → the affix. `name` is absent for the ones the game leaves
   * unnamed (crafting bonuses); the key's presence still means "known".
   */
  affixes: Record<string, DbAffix>;
  /** Fully indexed skills — mastery trees, devotion, and the records they point at. */
  skills: Record<string, DbSkill>;
  /**
   * Every `records/skills/` path → `[localized name, template class]`, so a
   * `+N to <skill>` reference always renders as a name. Two strings per record
   * is cheap enough to hold all of them; full stats are the `skills` subset.
   */
  skillNames: Record<string, [string, string]>;
  sets: Record<string, DbSet>;
  /** Difficulty name → raw `defensive*` field → the (negative) penalty it takes. */
  difficultyPenalty: Record<string, Record<string, number>>;
  /** `armorDefensiveAbsorption` — the 70% every armour piece absorbs by default. */
  armorAbsorptionBase: number;
  /** Player speed caps from the engine record — `+% speed` past these is wasted. */
  speedCaps: SpeedCaps;
  factions: DbFaction[];
  /** faction id → market tier → item record paths. */
  vendor: Record<string, Partial<Record<RepTier, string[]>>>;
  recipes: DbRecipe[];
  /** Kept inline so `localize()` works from the cache alone. */
  l10n: Record<string, string>;
  localizedNames: number;
}

/**
 * Only these subtrees are decompressed. The archives hold ~82k records; items,
 * skills, merchants and factions are the ~41k we have any use for, and skipping
 * the rest is most of the parse time.
 */
const WANTED_PREFIXES = [
  'records/items/',
  'records/skills/',
  'records/creatures/npcs/merchants/',
  'records/controllers/factions/',
  'records/game/gamefactions.dbr',
  'records/game/balancingadjustment_mp+difficulty_players01.dbr',
  'records/game/gameengine.dbr',
  // The 13 itemcost records whose equations produce attribute requirements.
  'records/game/itemcostformulas',
];

/**
 * Base armour absorption, as a percentage. `+% Armor Absorption` multiplies this
 * rather than adding to it — 70 × 1.2 = 84, not 90 — so the base has to be known
 * to report a resulting figure at all. Note `records/ingameui/gameengine.dbr` is
 * a different record carrying a stale 66; this one is the live engine record.
 */
const GAME_ENGINE_RECORD = 'records/game/gameengine.dbr';
const DEFAULT_ARMOR_ABSORPTION = 70;

/**
 * The engine's player speed caps (`playerAttackSpeedCapMax` and friends):
 * attack/cast 200, movement 135. An advisor that doesn't know them over-values
 * speed affixes on a build already at cap. Defaults match the installed 1.3.0.6
 * values in case the record ever goes missing.
 */
const DEFAULT_SPEED_CAPS = { attack: 200, cast: 200, run: 135 };

const GAME_FACTIONS_RECORD = 'records/game/gamefactions.dbr';

/**
 * The difficulty resistance penalty. It is *not* the flat "−25 / −50 to all
 * resistances" the difficulty-select screen implies: this record spells out a
 * different penalty per resistance, and Physical takes none at all. Reading it
 * beats hardcoding a number that would be wrong for six of the ten columns.
 */
const DIFFICULTY_ADJUSTMENT_RECORD = 'records/game/balancingadjustment_mp+difficulty_players01.dbr';

/**
 * Its arrays are 12 long: three difficulties × four player counts (the record's
 * name, `mp+difficulty`, says as much). Single-player is the first entry of each
 * group of four; multiplayer scaling is not something this tool models.
 */
const DIFFICULTY_ROWS: readonly { difficulty: string; index: number }[] = [
  { difficulty: 'Normal', index: 0 },
  { difficulty: 'Elite', index: 4 },
  { difficulty: 'Ultimate', index: 8 },
];

/** Template classes that represent something a character can actually hold. */
const ITEM_CLASS = /^(Armor|Weapon|Item|OneShot_|QuestItem)/;
/** Prefixes and suffixes; their display name lives in `lootRandomizerName`. */
const AFFIX_CLASS = 'LootRandomizer';
/** Set records leave `Class` empty, so the template is the only thing to key on. */
const ITEM_SET_TEMPLATE = 'database/templates/itemset.tpl';

/**
 * Skill subtrees indexed with their full per-rank stats: the two mastery trees a
 * character can pick and the devotion constellation. Everything else under
 * `records/skills/` (monster skills, the potion tables) is name-only — plus
 * whatever items point at, which `buildSkills` pulls in below.
 */
const DEEP_SKILL_PREFIX = /^records\/skills\/(playerclass\d+|devotion)\//;

/**
 * Pets are out of scope (see the stage plan's exclusion list) and they are also
 * most of the data: the `pets/` subtrees carry a per-pet copy of every summon's
 * scaling table and account for four fifths of the skill bytes on their own.
 */
const PET_SKILL_PATH = /\/pets\//;
/** …and `SkillTree`, which is an ordered list of buttons with no stats at all. */
const UNINDEXED_SKILL_CLASS = /^(Pet|PetPlayerScaling|SkillTree|Skill.*Pet.*)$/;

/** Fields on an item or affix that name a skill record worth indexing deeply. */
const SKILL_REFERENCE_KEYS = /^(itemSkillName|augmentSkillName\d*|augmentMasteryName\d*|modifiedSkillName\d*|modifierSkillName\d*)$/;

export interface GameRecords {
  records: Map<string, ArzRecord>;
  /** record path → the archive that last defined it. */
  expansions: Map<string, string>;
}

/**
 * Read every archive in order, letting later ones overwrite earlier ones. That
 * last-wins merge is how the expansions patch base-game items — an item touched
 * by GDX3 must come out with GDX3's numbers.
 */
export function readGameRecords(archives: GameArchive[]): GameRecords {
  const records = new Map<string, ArzRecord>();
  const expansions = new Map<string, string>();
  const filter = (record: string): boolean => WANTED_PREFIXES.some((p) => record.startsWith(p));

  for (const archive of archives) {
    const parsed = readArz(readFileSync(archive.path), { filter });
    for (const [path, rec] of parsed) {
      records.set(path, rec);
      expansions.set(path, archive.expansion);
    }
  }
  return { records, expansions };
}

// ---------------------------------------------------------------------------
// Stat extraction
// ---------------------------------------------------------------------------

/**
 * Where an item's inventory icon lives, by item family: gear and augments use
 * `bitmap`, relics `artifactBitmap`, components `relicBitmap`, blueprints
 * `artifactFormulaBitmapName`. Checked in this order.
 */
const ICON_KEYS = ['bitmap', 'artifactBitmap', 'relicBitmap', 'artifactFormulaBitmapName'] as const;

/** Fields modelled explicitly on `DbItem`, or pure engine/render plumbing. */
const NON_STAT_KEYS = new Set<string>([
  'templateName',
  'Class',
  'ActorName',
  'FileDescription',
  'itemNameTag',
  'description',
  'itemText',
  'itemSetName',
  'itemClassification',
  'levelRequirement',
  'itemCostName',
  // Present on ~10k records but zero everywhere except one quest item; the
  // requirement model reads them, `stats` shouldn't.
  'strengthRequirement',
  'dexterityRequirement',
  'intelligenceRequirement',
  ...ICON_KEYS,
  'shardBitmap',
  'baseTexture',
  'bumpTexture',
  'glowTexture',
  'shaderData',
  'actorHeight',
  'actorRadius',
  'allowTransparency',
  'castsShadows',
  'cannotPickUp',
  'cannotPickUpMultiple',
  'useMeshRadius',
  'droppable',
  // Render/physics plumbing that survived the zero-drop rule. Besides being
  // noise in the advisor context, anything left here inflates the stat count
  // the ring/amulet requirement kicker is scaled by.
  'maxTransparency',
  'outlineThickness',
  'physicsFriction',
  'physicsMass',
  'scale',
  // Loot-table bookkeeping on affix records; `jitter` is modelled explicitly.
  'lootRandomizerName',
  'lootRandomizerCost',
  'lootRandomizerJitter',
  'lootRandomizerWeight',
  'marketAdjustmentPercent',
]);

/**
 * Use-on slot flags on component (`ItemRelic`) and augment (`ItemEnchantment`)
 * records — boolean template fields, value 1 when the socketable fits that gear
 * family, spelled out at zero (and so dropped) otherwise. Verified against the
 * installed archives: exactly these 23 keys occur, only on those two classes,
 * never with a value other than 1. They move to `DbItem.allowedSlots` rather
 * than staying in `stats`, where they would read as junk stat lines.
 */
const SLOT_FLAG_KEYS = [
  'amulet',
  'medal',
  'ring',
  'head',
  'chest',
  'shoulders',
  'hands',
  'legs',
  'feet',
  'waist',
  'offhand',
  'shield',
  'sword',
  'sword2h',
  'axe',
  'axe2h',
  'mace',
  'mace2h',
  'dagger',
  'scepter',
  'spear2h',
  'ranged1h',
  'ranged2h',
] as const;

const SOCKETABLE_CLASSES = new Set(['ItemRelic', 'ItemEnchantment']);

/** Asset references — meaningless to an advisor, and they dominate the byte count. */
const ASSET_VALUE = /\.(tex|msh|anm|wav|pfx|tpl|fnt|ssh|lua)$/i;
/** Record references worth keeping despite pointing at another DBR. */
const MEANINGFUL_RECORD_KEY = /skill|mastery|bonusTable|artifactName|reagent|conversion|petBonus/i;

/**
 * String arrays that *are* stats. Arrays are otherwise level tables and loot
 * weights, but `racialBonusRace` names which enemy races the racial damage
 * bonus beside it applies to, and it is written as a list whenever there is
 * more than one — dropping it turns "+8% Damage to Aetherials and Aether
 * Corruptions" into "+8% damage to something".
 */
const STRING_LIST_KEYS = new Set(['racialBonusRace']);

/**
 * The item's stats as raw DBR keys, which is what the context document and the
 * advisor prompt want — no invented vocabulary between the game and the model.
 * Zeros are dropped: DBR records spell out every field in their template, so a
 * kept zero says "this template has the field", not "this item grants none".
 */
function extractStats(fields: Record<string, unknown>): Record<string, number | string> {
  const stats: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (NON_STAT_KEYS.has(key)) continue;
    if (typeof value === 'number') {
      if (value === 0) continue;
      stats[key] = value;
    } else if (typeof value === 'string') {
      if (value === '') continue;
      if (ASSET_VALUE.test(value)) continue;
      if (value.endsWith('.dbr') && !MEANINGFUL_RECORD_KEY.test(key)) continue;
      stats[key] = value;
    } else if (Array.isArray(value) && STRING_LIST_KEYS.has(key)) {
      const list = value.filter((entry): entry is string => typeof entry === 'string');
      if (list.length) stats[key] = list.join(';');
    }
    // Every other array is a level table or a loot weight — not a per-item stat.
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Attribute requirements
// ---------------------------------------------------------------------------

/**
 * Which equation family an item's `Class` reads in its `itemCostName` record —
 * `chest` means `chestStrengthEquation`, `chestIntelligenceEquation` and so on.
 * Requirements are *not* stored on item records: the explicit
 * `strengthRequirement` fields are zero on every item but one quest item, and
 * the real values are these equations evaluated at the item's `itemLevel`.
 *
 * Spears have no equations of their own anywhere (the `spear*` template keys
 * are unpopulated in all 13 cost records), so `Spear2h` reads `melee2h` like
 * the other two-handers. Medals map to a family that is likewise never
 * populated — a medal genuinely requires nothing, and must not fall into any
 * other bucket.
 */
const COST_EQUATION_PREFIX: Record<string, string> = {
  ArmorProtective_Head: 'head',
  ArmorProtective_Shoulders: 'shoulders',
  ArmorProtective_Chest: 'chest',
  ArmorProtective_Hands: 'hands',
  ArmorProtective_Legs: 'legs',
  ArmorProtective_Feet: 'feet',
  ArmorProtective_Waist: 'waist',
  ArmorJewelry_Amulet: 'amulet',
  ArmorJewelry_Ring: 'ring',
  ArmorJewelry_Medal: 'medal',
  WeaponMelee_Axe: 'axe',
  WeaponMelee_Mace: 'mace',
  WeaponMelee_Sword: 'sword',
  WeaponMelee_Dagger: 'dagger',
  WeaponMelee_Scepter: 'scepter',
  WeaponMelee_Axe2h: 'melee2h',
  WeaponMelee_Mace2h: 'melee2h',
  WeaponMelee_Sword2h: 'melee2h',
  WeaponMelee_Spear2h: 'melee2h',
  WeaponHunting_Ranged1h: 'ranged1h',
  WeaponHunting_Ranged2h: 'ranged2h',
  WeaponArmor_Shield: 'shield',
  WeaponArmor_Offhand: 'offhand',
};

/** Data name → save-file name: strength is Physique, dexterity Cunning, intelligence Spirit. */
const ATTR_EQUATION_KEYS = [
  ['Strength', 'physique'],
  ['Dexterity', 'cunning'],
  ['Intelligence', 'spirit'],
] as const;

const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * An item's attribute requirements: the explicit fields when non-zero (one
 * quest item in the whole game), otherwise its cost record's equations at
 * `totalAttCount = 1`. Ring and amulet equations also carry a `totalAttCount`
 * term — per populated stat on the *rolled* item, which the DB cannot know —
 * so its linear step is captured separately by evaluating at 2 and differencing,
 * for the resolver to scale by the real stat count.
 */
function buildAttrRequirements(
  rec: ArzRecord,
  cls: string,
  records: Map<string, ArzRecord>,
): Pick<DbItem, 'attrReq' | 'attrReqPerStat'> {
  const explicit: AttrRequirements = {};
  for (const [attr, key] of ATTR_EQUATION_KEYS) {
    const value = num(rec, `${attr.toLowerCase()}Requirement`);
    if (value) explicit[key] = value;
  }
  if (Object.keys(explicit).length > 0) return { attrReq: explicit };

  const costRef = str(rec, 'itemCostName');
  const cost = costRef ? records.get(costRef) : undefined;
  const prefix = COST_EQUATION_PREFIX[cls];
  const itemLevel = num(rec, 'itemLevel');
  if (!cost || !prefix || !itemLevel) return {};

  const attrReq: AttrRequirements = {};
  const perStat: AttrRequirements = {};
  for (const [attr, key] of ATTR_EQUATION_KEYS) {
    const equation = str(cost, `${prefix}${attr}Equation`);
    if (!equation) continue;
    let baseline: number;
    try {
      baseline = evaluateFormula(equation, { itemLevel, totalAttCount: 1 });
    } catch {
      continue; // an equation the evaluator can't read is a missing value, not a crash
    }
    if (baseline <= 0) continue;
    attrReq[key] = round1(baseline);
    if (equation.includes('totalAttCount')) {
      const step = evaluateFormula(equation, { itemLevel, totalAttCount: 2 }) - baseline;
      if (step > 0) perStat[key] = round1(step);
    }
  }
  if (Object.keys(attrReq).length === 0) return {};
  const result: Pick<DbItem, 'attrReq' | 'attrReqPerStat'> = { attrReq };
  if (Object.keys(perStat).length > 0) result.attrReqPerStat = perStat;
  return result;
}

/** Fields modelled explicitly on `DbSkill`, or pure UI/audio plumbing. */
const NON_SKILL_STAT_KEYS = new Set<string>([
  'templateName',
  'Class',
  'FileDescription',
  'ActorName',
  'skillDisplayName',
  'skillBaseDescription',
  'skillTier',
  'skillMaxLevel',
  'skillUltimateLevel',
  'skillCooldownTime',
  'skillActiveDuration',
  'buffSkillName',
  'characterBaseAttackSpeedTag',
  'distanceProfile',
  'skillConnectionOn',
  'skillConnectionOff',
]);

/** Presentation keys, matched by shape because the game names them freely. */
const SKILL_PRESENTATION_KEY = /(bitmap|sound|texture|animation|anim$|^camera|particle|^charFxPak|^skillCastAura|fxpak)/i;

/**
 * A skill's stats, keeping the per-rank arrays the item extractor drops.
 *
 * The arrays *are* the point: `characterOffensiveAbility = [10,20,29,…]` is
 * worth nothing collapsed to a scalar, because a skill's contribution to a
 * resistance total depends on the rank the character actually has it at.
 * All-zero arrays go the way of zero scalars — the template declaring a field is
 * not the skill granting it.
 */
export function extractSkillStats(fields: Record<string, ArzValue>): Record<string, StatValue> {
  const stats: Record<string, StatValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (NON_SKILL_STAT_KEYS.has(key)) continue;
    if (SKILL_PRESENTATION_KEY.test(key)) continue;
    if (typeof value === 'number') {
      if (value !== 0) stats[key] = value;
    } else if (typeof value === 'string') {
      if (value === '' || ASSET_VALUE.test(value)) continue;
      if (value.endsWith('.dbr') && !MEANINGFUL_RECORD_KEY.test(key)) continue;
      stats[key] = value;
    } else if (Array.isArray(value) && typeof value[0] === 'number') {
      const ranks = value as number[];
      if (ranks.some((v) => v !== 0)) stats[key] = ranks;
    }
    // String arrays at this point are asset lists; nothing numeric to aggregate.
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export interface BuildInput {
  game: GameRecords;
  l10n: Record<string, string>;
  gameVersion: string;
  locale: string;
  locales: string[];
  fingerprint: string;
  archives: string[];
  /** Injected so the cache carries a real timestamp without the build being impure. */
  now?: Date;
}

/**
 * Strip the game's inline markup.
 *
 * Localized strings carry `^<letter>` codes — `^k` tints tier-2 component names
 * gold, `^n` is a line break, `^w` resets.
 *
 * Gendered languages add a declension system on top. A noun opens with the
 * grammatical marker it *is* (`[ms]` masculine singular, `[np]` neuter plural;
 * 3,215 of the Russian table's entries carry one), and an adjective spells out
 * every form it *could take*, each behind its own marker:
 * `[ms]искусный[fs]искусная[ns]искусное[np]искусные`. The engine picks the
 * adjective form matching the noun.
 *
 * We drop the noun's marker and keep an adjective's first form. That is right in
 * every ungendered language and readable in the rest; full agreement needs the
 * noun's gender carried to the point where the affix is applied, which is a
 * backlog item (see RUNBOOK.md) and affects only the 365 adjectival tags.
 */
export function cleanText(text: string): string {
  return text
    .replace(/\^n/g, '\n')
    .replace(/\^[a-zA-Z]/g, '')
    .replace(/^\s*\[[mfn][sp]\]/, '')
    .replace(/\[[mfn][sp]\][\s\S]*$/, '')
    .trim();
}

export function buildDb(input: BuildInput): NormalizedDb {
  const { records, expansions } = input.game;
  const l10n = input.l10n;
  const localize = (tag: string | undefined): string | undefined => {
    if (tag === undefined) return undefined;
    const text = l10n[tag];
    return text === undefined ? undefined : cleanText(text);
  };

  const skillNames = buildSkillNames(records, localize);

  const items: Record<string, DbItem> = {};
  const affixes: Record<string, DbAffix> = {};
  // Skill records items and affixes point at. They are indexed deeply too, so an
  // awakened item's modifier payload or a rune's granted skill is renderable.
  const referencedSkills = new Set<string>();
  let localizedNames = 0;

  for (const [path, rec] of records) {
    if (!path.startsWith('records/items/')) continue;
    const cls = str(rec, 'Class') ?? rec.type;

    for (const [key, value] of Object.entries(rec.fields)) {
      if (!SKILL_REFERENCE_KEYS.test(key)) continue;
      if (typeof value === 'string' && value.startsWith('records/skills/')) referencedSkills.add(value);
    }

    if (cls === AFFIX_CLASS) {
      // Crafting-bonus affixes have no `lootRandomizerName` at all — the game
      // shows their stats inline rather than a name. Recording them without one
      // keeps "nameless by design" distinguishable from "missing".
      const affix: DbAffix = { record: path, stats: extractStats(rec.fields) };
      const name = localize(str(rec, 'lootRandomizerName'));
      if (name) affix.name = name;
      const jitter = num(rec, 'lootRandomizerJitter');
      if (jitter) affix.jitter = jitter;
      const affixLevelReq = num(rec, 'levelRequirement');
      if (affixLevelReq) affix.levelReq = affixLevelReq;
      affixes[path] = affix;
      continue;
    }
    if (!ITEM_CLASS.test(cls)) continue;

    // Gear names its tag `itemNameTag`; relics, components, augments, blueprints
    // and quest items all use `description` for the same purpose.
    const nameTag = str(rec, 'itemNameTag') ?? str(rec, 'description');
    const localized = localize(nameTag);
    if (localized) localizedNames++;

    const item: DbItem = {
      record: path,
      // Falling back to FileDescription (the editor label) and then the record
      // stem keeps unnamed dev/placeholder records readable instead of blank.
      name: localized ?? str(rec, 'FileDescription') ?? recordStem(path),
      levelReq: num(rec, 'levelRequirement') ?? 0,
      rarity: str(rec, 'itemClassification') ?? 'Common',
      slot: cls,
      iconPath: ICON_KEYS.map((key) => str(rec, key)).find(Boolean) ?? '',
      stats: extractStats(rec.fields),
      ...buildAttrRequirements(rec, cls, records),
    };

    // Socketables: lift the use-on flags out of `stats` into the typed field.
    // Presence implies 1 — `extractStats` already dropped the zeroed flags.
    if (SOCKETABLE_CLASSES.has(cls)) {
      const allowed = SLOT_FLAG_KEYS.filter((key) => item.stats[key] !== undefined);
      for (const key of allowed) delete item.stats[key];
      if (allowed.length > 0) item.allowedSlots = allowed;
    }

    const setRecord = str(rec, 'itemSetName');
    const setName = setRecord ? localize(str(records.get(setRecord), 'setName')) : undefined;
    if (setName) item.setName = setName;
    if (setRecord && records.has(setRecord)) item.setRecord = setRecord;

    const granted = str(rec, 'itemSkillName');
    const grantedName = granted ? skillNames[granted]?.[0] : undefined;
    if (granted && grantedName) item.grantedSkill = { record: granted, name: grantedName };

    const expansion = expansions.get(path);
    if (expansion) item.expansion = expansion;

    const description = localize(str(rec, 'itemText'));
    if (description) item.description = description;

    items[path] = item;
  }

  const skills = buildSkills(records, skillNames, referencedSkills, localize);
  const sets = buildSets(records, localize);
  const difficultyPenalty = buildDifficultyPenalty(records);
  const armorAbsorptionBase =
    num(records.get(GAME_ENGINE_RECORD), 'armorDefensiveAbsorption') ?? DEFAULT_ARMOR_ABSORPTION;
  const engine = records.get(GAME_ENGINE_RECORD);
  const speedCaps: SpeedCaps = {
    attack: num(engine, 'playerAttackSpeedCapMax') ?? DEFAULT_SPEED_CAPS.attack,
    cast: num(engine, 'playerSpellCastSpeedCapMax') ?? DEFAULT_SPEED_CAPS.cast,
    run: num(engine, 'playerRunSpeedCapMax') ?? DEFAULT_SPEED_CAPS.run,
  };
  const { factions, vendor } = buildFactions(records, items, localize);
  const recipes = buildRecipes(records, items);

  return {
    schemaVersion: DB_SCHEMA_VERSION,
    gameVersion: input.gameVersion,
    locale: input.locale,
    locales: input.locales,
    fingerprint: input.fingerprint,
    builtAt: (input.now ?? new Date()).toISOString(),
    archives: input.archives,
    items,
    affixes,
    skills,
    skillNames,
    sets,
    difficultyPenalty,
    armorAbsorptionBase,
    speedCaps,
    factions,
    vendor,
    recipes,
    l10n,
    localizedNames,
  };
}

function recordStem(path: string): string {
  return path.split('/').pop()?.replace(/\.dbr$/, '') ?? path;
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

type Localize = (tag: string | undefined) => string | undefined;

/**
 * Name and class for every skill record in the game.
 *
 * Two strings per record is cheap, and holding all of them is what guarantees
 * that a `+N to <skill>` line — which may point anywhere, including another
 * mastery the character has not taken — renders as a name rather than a path.
 */
function buildSkillNames(
  records: Map<string, ArzRecord>,
  localize: Localize,
): Record<string, [string, string]> {
  const names: Record<string, [string, string]> = {};
  for (const [path, rec] of records) {
    if (!path.startsWith('records/skills/')) continue;
    const name = localize(str(rec, 'skillDisplayName')) ?? '';
    names[path] = [name, str(rec, 'Class') ?? rec.type];
  }
  return names;
}

/**
 * `records/skills/playerclass04/x.dbr` → that mastery's training record, which
 * is what a `+N to all <mastery> skills` bonus names.
 */
function masteryOf(path: string): string | undefined {
  const match = /^records\/skills\/(playerclass(\d+))\//.exec(path);
  return match ? `records/skills/${match[1]}/_classtraining_class${match[2]}.dbr` : undefined;
}

/**
 * Weapon fields on a skill record. When *any* of them is set the skill is
 * restricted to those weapons; all-zero means it fires with anything. Only a
 * dozen or so player skills are restricted, but they are build-defining ones,
 * and advising a weapon swap that silently disables the main attack is the worst
 * answer this tool could give.
 */
const WEAPON_FIELDS = [
  'Axe',
  'Axe2h',
  'Dagger',
  'Mace',
  'Mace2h',
  'Magical',
  'Offhand',
  'Ranged1h',
  'Ranged2h',
  'Scepter',
  'Shield',
  'Spear',
  'Staff',
  'Sword',
  'Sword2h',
] as const;

/**
 * Index the skills worth full per-rank stats: the mastery trees, devotion, every
 * record an item or affix points at, and — one hop further — the `buffSkillName`
 * target of each of those. That last hop is not optional: a toggled aura's
 * activator record holds nothing but the pointer, so without it Veil of Shadows
 * and every other toggle would contribute zero.
 */
function buildSkills(
  records: Map<string, ArzRecord>,
  skillNames: Record<string, [string, string]>,
  referenced: Set<string>,
  localize: Localize,
): Record<string, DbSkill> {
  const inScope = (path: string): boolean =>
    !PET_SKILL_PATH.test(path) && !UNINDEXED_SKILL_CLASS.test(skillNames[path]?.[1] ?? '');

  const wanted = new Set<string>([...referenced].filter(inScope));
  for (const path of Object.keys(skillNames)) {
    if (DEEP_SKILL_PREFIX.test(path) && inScope(path)) wanted.add(path);
  }
  for (const path of [...wanted]) {
    const buff = str(records.get(path), 'buffSkillName');
    if (buff) wanted.add(buff);
  }

  const skills: Record<string, DbSkill> = {};
  for (const path of wanted) {
    const rec = records.get(path);
    if (!rec) continue;

    const skill: DbSkill = {
      record: path,
      class: str(rec, 'Class') ?? rec.type,
      stats: extractSkillStats(rec.fields),
    };
    const name = skillNames[path]?.[0];
    if (name) skill.name = name;

    const assign = <K extends 'tier' | 'maxLevel' | 'ultimateLevel' | 'cooldown' | 'duration'>(
      key: K,
      value: number | undefined,
    ): void => {
      if (value !== undefined && value !== 0) skill[key] = value;
    };
    assign('tier', num(rec, 'skillTier'));
    assign('maxLevel', num(rec, 'skillMaxLevel'));
    assign('ultimateLevel', num(rec, 'skillUltimateLevel'));
    assign('cooldown', num(rec, 'skillCooldownTime'));
    assign('duration', num(rec, 'skillActiveDuration'));

    const buff = str(rec, 'buffSkillName');
    if (buff) skill.buffRecord = buff;

    const mastery = masteryOf(path);
    if (mastery && records.has(mastery)) skill.mastery = mastery;

    const weapons = WEAPON_FIELDS.filter((field) => num(rec, field));
    if (weapons.length) skill.weapons = [...weapons];

    const description = localize(str(rec, 'skillBaseDescription'));
    if (description) skill.description = description;

    skills[path] = skill;
  }
  return skills;
}

// ---------------------------------------------------------------------------
// Item sets
// ---------------------------------------------------------------------------

/** Set-record fields that describe the set rather than grant anything. */
const NON_SET_BONUS_KEYS = new Set<string>([
  'templateName',
  'Class',
  'FileDescription',
  'setName',
  'setMembers',
  'setDescription',
  'setSize',
  'itemLevel',
  'characterBaseAttackSpeedTag',
]);

function buildSets(records: Map<string, ArzRecord>, localize: Localize): Record<string, DbSet> {
  const sets: Record<string, DbSet> = {};
  for (const [path, rec] of records) {
    if (str(rec, 'templateName') !== ITEM_SET_TEMPLATE) continue;
    const members = strList(rec, 'setMembers');
    const bonuses: Record<string, StatValue> = {};
    for (const [key, value] of Object.entries(rec.fields)) {
      if (NON_SET_BONUS_KEYS.has(key)) continue;
      if (typeof value === 'number') {
        if (value !== 0) bonuses[key] = value;
      } else if (typeof value === 'string') {
        if (value !== '' && !ASSET_VALUE.test(value)) bonuses[key] = value;
      } else if (Array.isArray(value) && typeof value[0] === 'number') {
        const byPieces = value as number[];
        if (byPieces.some((v) => v !== 0)) bonuses[key] = byPieces;
      }
    }
    sets[path] = {
      record: path,
      name: localize(str(rec, 'setName')) ?? str(rec, 'FileDescription') ?? recordStem(path),
      members,
      bonuses,
    };
  }
  return sets;
}

/**
 * The per-difficulty resistance penalty, straight from the game's own balancing
 * record. Every negative entry is kept; a resistance the table leaves at zero
 * genuinely takes no penalty.
 */
function buildDifficultyPenalty(records: Map<string, ArzRecord>): Record<string, Record<string, number>> {
  const rec = records.get(DIFFICULTY_ADJUSTMENT_RECORD);
  const out: Record<string, Record<string, number>> = {};
  for (const { difficulty, index } of DIFFICULTY_ROWS) {
    const row: Record<string, number> = {};
    for (const [key, value] of Object.entries(rec?.fields ?? {})) {
      if (!key.startsWith('defensive') || !Array.isArray(value)) continue;
      const amount = value[index];
      if (typeof amount === 'number' && amount !== 0) row[key] = amount;
    }
    out[difficulty] = row;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Factions and their vendors
// ---------------------------------------------------------------------------

/** `factionUser8` → `f8`; `factionSurvivors` → `survivors`. */
function factionIdFromKey(key: string): string {
  const suffix = key.slice('faction'.length);
  const userMatch = /^User(\d+)$/.exec(suffix);
  return userMatch ? `f${userMatch[1]}` : suffix.toLowerCase();
}

/**
 * Faction identity comes from `records/game/gamefactions.dbr`, which is the
 * game's own numbered roster — the record filenames are not a reliable guide
 * (`factiongdx3_dread.dbr` is registered as the *Traps* faction, and vice versa).
 */
function buildFactions(
  records: Map<string, ArzRecord>,
  items: Record<string, DbItem>,
  localize: (tag: string | undefined) => string | undefined,
): { factions: DbFaction[]; vendor: Record<string, Partial<Record<RepTier, string[]>>> } {
  const roster = records.get(GAME_FACTIONS_RECORD);
  const byRecord = new Map<string, { id: string; nameTag: string }>();

  for (const [key, value] of Object.entries(roster?.fields ?? {})) {
    if (!key.startsWith('faction') || typeof value !== 'string') continue;
    if (!value.startsWith('records/controllers/factions/')) continue;
    byRecord.set(value, { id: factionIdFromKey(key), nameTag: `tagFaction${key.slice('faction'.length)}` });
  }

  // Market table → faction, learned from the merchant NPCs that stand behind
  // them (each carries both `marketFileName` and its `factions` allegiance).
  const marketToFaction = new Map<string, string>();
  for (const rec of records.values()) {
    const market = str(rec, 'marketFileName');
    const faction = str(rec, 'factions');
    if (market && faction) marketToFaction.set(market, faction);
  }

  const vendor: Record<string, Partial<Record<RepTier, string[]>>> = {};
  for (const [marketRecord, factionRecord] of marketToFaction) {
    const market = records.get(marketRecord);
    const faction = byRecord.get(factionRecord);
    if (!market || !faction) continue;

    for (const tier of REP_TIERS) {
      // `friendlyNormalTable`, `respectedNormalTable`, …
      const tableRecord = str(market, `${tier.toLowerCase()}NormalTable`);
      const stock = strList(records.get(tableRecord ?? ''), 'marketStaticItems').filter((r) => r in items);
      if (stock.length === 0) continue;
      ((vendor[faction.id] ??= {})[tier] ??= []).push(...stock);
    }
  }

  // Tag each stocked item with every vendor that sells it, at the cheapest tier
  // that faction unlocks it at. Iterating tiers ascending makes "cheapest" fall
  // out of the first write per faction.
  for (const [factionId, tiers] of Object.entries(vendor)) {
    for (const tier of REP_TIERS) {
      for (const record of tiers[tier] ?? []) {
        const item = items[record];
        if (!item) continue;
        const sources = (item.vendors ??= []);
        if (!sources.some((v) => v.factionId === factionId)) sources.push({ factionId, repTier: tier });
      }
    }
  }

  const factions: DbFaction[] = [];
  for (const [record, { id, nameTag }] of byRecord) {
    factions.push({
      id,
      name: factionName(records.get(record), nameTag, id, localize),
      record,
      hasVendor: vendor[id] !== undefined,
    });
  }
  factions.sort((a, b) => a.name.localeCompare(b.name));
  return { factions, vendor };
}

/**
 * Display name for a faction. The roster key usually implies the tag directly
 * (`factionUser8` → `tagFactionUser8`); where it does not, the faction's own
 * record names its reward tags (`tagFactionUser8Rewards1`), which carry the same
 * stem. Falling all the way through leaves the id, which is at least stable.
 */
function factionName(
  pack: ArzRecord | undefined,
  nameTag: string,
  id: string,
  localize: (tag: string | undefined) => string | undefined,
): string {
  const direct = localize(nameTag);
  if (direct) return direct;

  for (const value of Object.values(pack?.fields ?? {})) {
    for (const tag of Array.isArray(value) ? value : [value]) {
      if (typeof tag !== 'string' || !tag.startsWith('tagFaction')) continue;
      const stem = tag.replace(/(Rewards|Hostile|Bounty).*$/, '');
      if (stem === tag) continue;
      const name = localize(stem);
      if (name) return name;
    }
  }
  return id;
}

// ---------------------------------------------------------------------------
// Blueprints
// ---------------------------------------------------------------------------

/**
 * Blueprints, with what they consume.
 *
 * `ItemAscensionFormula` is deliberately not here: it crafts nothing specific,
 * rolling a random affix from weighted per-slot tables instead, so it has no
 * "result" to name and no advice to support beyond "ascension is a gamble".
 */
function buildRecipes(records: Map<string, ArzRecord>, items: Record<string, DbItem>): DbRecipe[] {
  const recipes: DbRecipe[] = [];
  for (const [path, rec] of records) {
    if ((str(rec, 'Class') ?? rec.type) !== 'ItemArtifactFormula') continue;
    const item = items[path];
    if (!item) continue;

    const reagent = (prefix: string): DbReagent | undefined => {
      const record = str(rec, `${prefix}BaseName`);
      if (!record) return undefined;
      const entry: DbReagent = { record, quantity: num(rec, `${prefix}Quantity`) ?? 1 };
      const name = items[record]?.name;
      if (name) entry.name = name;
      return entry;
    };

    const resultRecord = str(rec, 'artifactName');
    const recipe: DbRecipe = { record: path, name: item.name, reagents: [] };
    if (resultRecord) {
      recipe.resultRecord = resultRecord;
      const result = items[resultRecord];
      if (result) recipe.resultName = result.name;
    }

    const base = reagent('reagentBase');
    if (base) recipe.baseReagent = base;
    for (let i = 1; ; i++) {
      const next = reagent(`reagent${i}`);
      if (!next) break;
      recipe.reagents.push(next);
    }
    // The DBR stores the iron cost as text ("200000"), not a number.
    const cost = Number(str(rec, 'artifactCreationCost') ?? num(rec, 'artifactCreationCost'));
    if (Number.isFinite(cost) && cost > 0) recipe.ironCost = cost;

    recipes.push(recipe);
  }
  recipes.sort((a, b) => a.name.localeCompare(b.name));
  return recipes;
}
