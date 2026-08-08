/**
 * Turning raw `.arz` records plus a localization table into the normalized
 * database the rest of the tool consumes.
 *
 * The output is plain JSON: it gets cached as `db.json` so that after the first
 * run startup is a single file read with no archive parsing and no network.
 */

import { readFileSync } from 'node:fs';

import { num, readArz, str, strList, type ArzRecord } from './arz.js';
import type { GameArchive } from './gamefiles.js';
import { REP_TIERS, type DbFaction, type DbItem, type DbRecipe, type RepTier } from './types.js';

/** Bump when the shape below changes so stale caches rebuild instead of misreading. */
export const DB_SCHEMA_VERSION = 4;

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
   * Affix record path → localized name. The value is `''` for affixes the game
   * leaves unnamed (crafting bonuses); the key's presence still means "known".
   */
  affixes: Record<string, string>;
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
 * merchants and factions are the ~27k we have any use for, and skipping the rest
 * is most of the parse time.
 */
const WANTED_PREFIXES = [
  'records/items/',
  'records/creatures/npcs/merchants/',
  'records/controllers/factions/',
  'records/game/gamefactions.dbr',
];

const GAME_FACTIONS_RECORD = 'records/game/gamefactions.dbr';

/** Template classes that represent something a character can actually hold. */
const ITEM_CLASS = /^(Armor|Weapon|Item|OneShot_|QuestItem)/;
/** Prefixes and suffixes; their display name lives in `lootRandomizerName`. */
const AFFIX_CLASS = 'LootRandomizer';

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
]);

/** Asset references — meaningless to an advisor, and they dominate the byte count. */
const ASSET_VALUE = /\.(tex|msh|anm|wav|pfx|tpl|fnt|ssh|lua)$/i;
/** Record references worth keeping despite pointing at another DBR. */
const MEANINGFUL_RECORD_KEY = /skill|mastery|bonusTable|artifactName|reagent|conversion/i;

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
    }
    // Arrays are level tables and loot weights — not per-item stats.
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

  const items: Record<string, DbItem> = {};
  const affixes: Record<string, string> = {};
  let localizedNames = 0;

  for (const [path, rec] of records) {
    if (!path.startsWith('records/items/')) continue;
    const cls = str(rec, 'Class') ?? rec.type;

    if (cls === AFFIX_CLASS) {
      // Crafting-bonus affixes have no `lootRandomizerName` at all — the game
      // shows their stats inline rather than a name. Recording them as `''`
      // keeps "nameless by design" distinguishable from "missing".
      affixes[path] = localize(str(rec, 'lootRandomizerName')) ?? '';
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
    };

    const setRecord = str(rec, 'itemSetName');
    const setName = setRecord ? localize(str(records.get(setRecord), 'setName')) : undefined;
    if (setName) item.setName = setName;

    const expansion = expansions.get(path);
    if (expansion) item.expansion = expansion;

    const description = localize(str(rec, 'itemText'));
    if (description) item.description = description;

    items[path] = item;
  }

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

function buildRecipes(records: Map<string, ArzRecord>, items: Record<string, DbItem>): DbRecipe[] {
  const recipes: DbRecipe[] = [];
  for (const [path, rec] of records) {
    if ((str(rec, 'Class') ?? rec.type) !== 'ItemArtifactFormula') continue;
    const item = items[path];
    if (!item) continue;
    const resultRecord = str(rec, 'artifactName');
    const recipe: DbRecipe = { record: path, name: item.name };
    if (resultRecord) {
      recipe.resultRecord = resultRecord;
      const result = items[resultRecord];
      if (result) recipe.resultName = result.name;
    }
    recipes.push(recipe);
  }
  recipes.sort((a, b) => a.name.localeCompare(b.name));
  return recipes;
}
