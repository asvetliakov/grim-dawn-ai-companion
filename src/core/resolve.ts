/**
 * Turning saved item instances into something a human (or a model) can read.
 *
 * A save stores an item as record paths plus a seed — `baseName` names the base
 * item, `prefixName`/`suffixName` name the rolled affixes, `relicName` the fitted
 * component, `augmentName` the applied augment. Every display name, stat and icon
 * comes from the game database keyed on those paths.
 *
 * What this deliberately does *not* do is re-roll the seed. Reproducing the
 * engine's affix rolls would mean reimplementing its RNG; the advisor works from
 * base stats plus named affixes, and the context document labels those numbers as
 * the base values they are.
 */

import type { DbAffix, DbItem, GameDb } from './db/types.js';
import type { FormulasFile, MaterialStore } from './save/gst.js';
import type { TransferStash } from './save/gst.js';
import {
  EQUIP_SLOT_NAMES,
  type CharacterSave,
  type ItemInstance,
  type PositionedItem,
} from './save/types.js';

/**
 * Where an item was found. `materials` is the account-wide reagent store
 * (`reagents.gst`) — crafting materials *and every loose component*, which is
 * where components actually live: the game moves one there the moment it is
 * picked up, so a bag copy is the exception rather than the rule.
 */
export type ItemSource = 'equipped' | 'inventory' | 'stash' | 'transfer' | 'materials';

/**
 * What this rolled item demands of a character, before any `-% Requirement`
 * reduction (those depend on the rest of the loadout — the mechanics layer's
 * `checkRequirements` applies them).
 */
export interface ItemRequirements {
  /**
   * Affixes gate the item too: the level shown in game is the max of the base
   * item's and both affixes' requirements, not the base field alone.
   */
  level: number;
  physique?: number;
  cunning?: number;
  spirit?: number;
}

export interface ResolvedItem {
  /**
   * Short stable handle, derived from the saved instance (record + seeds +
   * attachments). Names are ambiguous — two rings can read identically — so the
   * context document prints this beside every item and the advisor's structured
   * output keys on it. Derived, not stored, so the renderer and the UI arrive at
   * the same string from the same save.
   */
  id: string;
  /** The base item's record path, as stored in the save. */
  record: string;
  /** Full name, e.g. "Thunderstruck Legion Warhammer of Alacrity". */
  display: string;
  /** Undefined when the record is not in the database — see `unresolved`. */
  base?: DbItem;
  prefixName?: string;
  suffixName?: string;
  /** Rare-monster / ascension modifier affix, when the item carries one. */
  modifierName?: string;
  /**
   * The affix records behind those names, with their stats. On magical and rare
   * gear the affixes carry most of the resistances, so an aggregate built from
   * `base` alone reads far too low.
   */
  prefix?: DbAffix;
  suffix?: DbAffix;
  modifier?: DbAffix;
  /** The rolled completion bonus on a relic (`relicBonus` in the save). */
  completion?: DbAffix;
  component?: DbItem;
  augment?: DbItem;
  source: ItemSource;
  /** Absent only when the base record didn't resolve. */
  requirements?: ItemRequirements;
  /** Human-readable place: slot name, sack number, stash tab, grid position. */
  location: string;
  stackCount: number;
  /** Record paths that did not resolve — the raw material of the coverage report. */
  unresolved: string[];
}

export interface ResolutionCoverage {
  /** Distinct base-item record paths seen. */
  baseTotal: number;
  baseResolved: number;
  baseMissing: string[];
  /** Distinct prefix/suffix/modifier record paths seen. */
  affixTotal: number;
  affixResolved: number;
  affixMissing: string[];
  /** Resolved affixes the game gives no name — crafting bonuses. */
  affixUnnamed: string[];
}

export interface ResolvedRecipe {
  record: string;
  name?: string;
  resultName?: string;
  read: boolean;
}

export interface ResolvedCharacter {
  name: string;
  level: number;
  items: ResolvedItem[];
  recipes: ResolvedRecipe[];
  coverage: ResolutionCoverage;
}

/** Records that resolve to nothing on purpose: the save's "empty" sentinel. */
function isEmpty(record: string): boolean {
  return record === '';
}

/**
 * Resolve one item instance.
 *
 * `track` collects what failed to resolve; the caller aggregates it into the
 * coverage report. Passing it in (rather than returning a merged tally) keeps the
 * distinction between base records and affix records, which have very different
 * expected coverage.
 */
export function resolveItem(
  inst: ItemInstance,
  db: GameDb,
  source: ItemSource,
  location: string,
  track?: CoverageTracker,
): ResolvedItem {
  const unresolved: string[] = [];

  const base = db.getItem(inst.baseName);
  track?.base(inst.baseName, base !== undefined);
  if (!base && !isEmpty(inst.baseName)) unresolved.push(inst.baseName);

  const affix = (record: string): { name?: string; affix?: DbAffix } => {
    if (isEmpty(record)) return {};
    // Affixes live in the loot-randomizer table; a handful of item records are
    // used as modifiers too, so fall back to the item name before giving up.
    const entry = db.getAffix(record);
    const name = entry?.name ?? db.getItem(record)?.name;
    // A crafting bonus is *known* even though it has no name, so it counts as
    // resolved — the alternative reports the game's own design as our failure.
    const known = name !== undefined || db.knowsAffix(record);
    track?.affix(record, known, name !== undefined);
    if (!known) unresolved.push(record);
    return { ...(name !== undefined ? { name } : {}), ...(entry ? { affix: entry } : {}) };
  };

  const prefix = affix(inst.prefixName);
  const suffix = affix(inst.suffixName);
  const modifier = affix(inst.modifierName);
  // A relic's rolled completion bonus. It is an ordinary `LootRandomizer`
  // record, so its stats come through the same path as a prefix's.
  const completion = affix(inst.relicBonus);

  const attachment = (record: string): DbItem | undefined => {
    if (isEmpty(record)) return undefined;
    const item = db.getItem(record);
    track?.base(record, item !== undefined);
    if (!item) unresolved.push(record);
    return item;
  };

  const component = attachment(inst.relicName);
  const augment = attachment(inst.augmentName);

  const item: ResolvedItem = {
    id: itemId(inst),
    record: inst.baseName,
    display: [prefix.name, base?.name ?? recordStem(inst.baseName), suffix.name].filter(Boolean).join(' '),
    source,
    location,
    stackCount: inst.stackCount,
    unresolved,
  };
  if (base) item.base = base;
  if (prefix.name) item.prefixName = prefix.name;
  if (suffix.name) item.suffixName = suffix.name;
  if (modifier.name) item.modifierName = modifier.name;
  if (prefix.affix) item.prefix = prefix.affix;
  if (suffix.affix) item.suffix = suffix.affix;
  if (modifier.affix) item.modifier = modifier.affix;
  if (completion.affix) item.completion = completion.affix;
  if (component) item.component = component;
  if (augment) item.augment = augment;
  if (base) item.requirements = requirements(base, prefix.affix, suffix.affix);
  return item;
}

/**
 * Keys the engine's `totalAttCount` plausibly tallies: actual character,
 * offensive, defensive, retaliation and skill-augment entries. Metadata that
 * merely lives beside them (`itemLevel`, `attributeScalePercent`) must not
 * count — every miscounted key adds a phantom ~3% of `itemLevel × 3` to a
 * ring's Spirit requirement.
 */
const COUNTED_STAT_KEY = /^(character|offensive|defensive|retaliation|augment|skill)/;

/**
 * The rolled item's own requirements. Ring and amulet equations scale with the
 * number of populated stat entries on the item; counting the base's and both
 * affixes' stat keys approximates the engine's tally — the step is ~3% of
 * `itemLevel × 3` per stat, so a miscount of one is a few points, and the DB's
 * per-affix `jitter` note already frames these numbers as anchors, not rolls.
 */
function requirements(base: DbItem, prefix?: DbAffix, suffix?: DbAffix): ItemRequirements {
  const req: ItemRequirements = {
    level: Math.max(base.levelReq, prefix?.levelReq ?? 0, suffix?.levelReq ?? 0),
  };
  if (!base.attrReq) return req;
  const statCount = [base, prefix, suffix]
    .flatMap((part) => (part ? Object.entries(part.stats) : []))
    .filter(([key, value]) => typeof value === 'number' && COUNTED_STAT_KEY.test(key)).length;
  const extra = base.attrReqPerStat ? Math.max(0, statCount - 1) : 0;
  for (const key of ['physique', 'cunning', 'spirit'] as const) {
    const baseline = base.attrReq[key];
    if (baseline === undefined) continue;
    req[key] = Math.round(baseline + (base.attrReqPerStat?.[key] ?? 0) * extra);
  }
  return req;
}

/**
 * A short handle for a saved item instance.
 *
 * FNV-1a over the fields that make an instance what it is: the base record, the
 * roll seeds, the affix records and the fitted socketables. Four base-36
 * characters is ~1.7M values against the ~150 items a character can reach, so a
 * collision is rare — and the context builder still disambiguates the ones that
 * do happen, because two genuinely identical stacked items hash the same.
 */
export function itemId(inst: ItemInstance): string {
  const key = [
    inst.baseName,
    inst.seed,
    inst.prefixName,
    inst.suffixName,
    inst.modifierName,
    inst.relicName,
    inst.relicSeed,
    inst.augmentName,
    inst.augmentSeed,
  ].join('|');
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(4, '0').slice(-4);
}

function recordStem(record: string): string {
  return record.split('/').pop()?.replace(/\.dbr$/, '') ?? record;
}

/** Accumulates distinct record paths and whether each one resolved. */
export class CoverageTracker {
  private readonly baseSeen = new Map<string, boolean>();
  private readonly affixSeen = new Map<string, boolean>();
  private readonly affixNamed = new Map<string, boolean>();

  base(record: string, ok: boolean): void {
    if (!isEmpty(record)) this.baseSeen.set(record, (this.baseSeen.get(record) ?? false) || ok);
  }

  affix(record: string, ok: boolean, named = ok): void {
    if (isEmpty(record)) return;
    this.affixSeen.set(record, (this.affixSeen.get(record) ?? false) || ok);
    this.affixNamed.set(record, (this.affixNamed.get(record) ?? false) || named);
  }

  report(): ResolutionCoverage {
    const where = (m: Map<string, boolean>, want: boolean): string[] =>
      [...m].filter(([, ok]) => ok === want).map(([record]) => record).sort();
    return {
      baseTotal: this.baseSeen.size,
      baseResolved: [...this.baseSeen.values()].filter(Boolean).length,
      baseMissing: where(this.baseSeen, false),
      affixTotal: this.affixSeen.size,
      affixResolved: [...this.affixSeen.values()].filter(Boolean).length,
      affixMissing: where(this.affixSeen, false),
      // Known-but-nameless only; a record that failed outright is in affixMissing.
      affixUnnamed: where(this.affixNamed, false).filter((r) => this.affixSeen.get(r) === true),
    };
  }
}

function position(item: PositionedItem): string {
  return `(${Math.round(item.x)},${Math.round(item.y)})`;
}

/**
 * A reagent-store entry as an item instance.
 *
 * The store records only a record path and a count — no seed, no affixes, no
 * sockets — because nothing it holds can carry any. Synthesizing the instance
 * (rather than resolving these by a separate path) is what lets a loose
 * component flow into the census, the socketable index and the recipe
 * materials-on-hand map without any of them special-casing it.
 */
function materialInstance(record: string, quantity: number): ItemInstance {
  return {
    baseName: record,
    prefixName: '',
    suffixName: '',
    modifierName: '',
    transmuteName: '',
    seed: 0,
    relicName: '',
    relicBonus: '',
    relicSeed: 0,
    augmentName: '',
    unknown: 0,
    augmentSeed: 0,
    relicCompletionLevel: 0,
    stackCount: quantity,
    unknownExtra: [0, 0, 0, 0],
  };
}

/** The account-wide save files, all optional — a fresh install has none of them. */
export interface AccountFiles {
  /** `transfer.gst` — the shared transfer stash. */
  stash?: TransferStash | undefined;
  /** `formulas.gst` — learned blueprints. */
  formulas?: FormulasFile | undefined;
  /** `reagents.gst` — crafting materials and loose components. */
  materials?: MaterialStore | undefined;
}

/**
 * Resolve everything a character can reach: what they are wearing, both weapon
 * sets, the carried sacks, the personal stash, the shared transfer stash, the
 * account's reagent store, and its learned blueprints.
 *
 * Every account file is optional because each may legitimately be absent. Pass a
 * shared `track` to pool coverage across several characters — it counts distinct
 * record paths, so pooling is the only way to get an honest total when two
 * characters carry the same item.
 */
export function resolveCharacter(
  save: CharacterSave,
  account: AccountFiles,
  db: GameDb,
  track: CoverageTracker = new CoverageTracker(),
): ResolvedCharacter {
  const { stash, formulas, materials } = account;
  const items: ResolvedItem[] = [];

  save.equipment.forEach((item, i) => {
    if (item) items.push(resolveItem(item, db, 'equipped', EQUIP_SLOT_NAMES[i] ?? `Slot ${i}`, track));
  });
  const weaponSets: [string, CharacterSave['weaponSet1']][] = [
    ['Weapon set 1', save.weaponSet1],
    ['Weapon set 2', save.weaponSet2],
  ];
  for (const [label, set] of weaponSets) {
    set.forEach((weapon, i) => {
      if (weapon) items.push(resolveItem(weapon, db, 'equipped', `${label} ${i === 0 ? 'main' : 'off'}`, track));
    });
  }

  save.inventorySacks.forEach((sack, i) => {
    for (const item of sack) {
      items.push(resolveItem(item, db, 'inventory', `bag ${i + 1} ${position(item)}`, track));
    }
  });

  save.personalStash.forEach((tab, i) => {
    for (const item of tab.items) {
      items.push(resolveItem(item, db, 'stash', `tab ${i + 1} ${position(item)}`, track));
    }
  });

  stash?.sacks.forEach((sack, i) => {
    for (const item of sack.items) {
      items.push(resolveItem(item, db, 'transfer', `tab ${i + 1} ${position(item)}`, track));
    }
  });

  for (const entry of materials?.entries ?? []) {
    // The store keeps a row for anything the account has *ever* held, so a
    // quantity of zero means "none left", not "one". Passing it through would
    // read as a copy on hand everywhere downstream — the census, the recipe
    // materials pool — because a save's own `stackCount` is 0 for
    // non-stackables and every consumer floors it at 1.
    if (entry.quantity < 1) continue;
    items.push(
      resolveItem(materialInstance(entry.record, entry.quantity), db, 'materials', 'materials store', track),
    );
  }

  const recipes: ResolvedRecipe[] = (formulas?.entries ?? []).map((entry) => {
    const item = db.getItem(entry.record);
    // Blueprint records are items too, so a miss here is a genuine coverage gap.
    track.base(entry.record, item !== undefined);
    const recipe: ResolvedRecipe = { record: entry.record, read: entry.read };
    if (item) recipe.name = item.name;
    const resultName = db.recipes().find((r) => r.record === entry.record)?.resultName;
    if (resultName) recipe.resultName = resultName;
    return recipe;
  });

  return { name: save.name, level: save.level, items, recipes, coverage: track.report() };
}
