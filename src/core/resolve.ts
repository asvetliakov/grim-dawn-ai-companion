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
import type { FormulasFile } from './save/gst.js';
import type { TransferStash } from './save/gst.js';
import {
  EQUIP_SLOT_NAMES,
  type CharacterSave,
  type ItemInstance,
  type PositionedItem,
} from './save/types.js';

export type ItemSource = 'equipped' | 'inventory' | 'stash' | 'transfer';

export interface ResolvedItem {
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
  return item;
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
 * Resolve everything a character can reach: what they are wearing, both weapon
 * sets, the carried sacks, the personal stash, the shared transfer stash, and the
 * account's learned blueprints.
 *
 * `stash` and `formulas` are optional because they are account-wide files that
 * may legitimately be absent (a fresh install has no transfer stash). Pass a
 * shared `track` to pool coverage across several characters — it counts distinct
 * record paths, so pooling is the only way to get an honest total when two
 * characters carry the same item.
 */
export function resolveCharacter(
  save: CharacterSave,
  stash: TransferStash | undefined,
  formulas: FormulasFile | undefined,
  db: GameDb,
  track: CoverageTracker = new CoverageTracker(),
): ResolvedCharacter {
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
