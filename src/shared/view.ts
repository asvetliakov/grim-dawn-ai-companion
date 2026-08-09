/**
 * The character as the window sees it.
 *
 * Every shape here crosses an Electron IPC boundary, which means two hard
 * rules: it must survive the structured clone algorithm (no `Map`s, no class
 * instances, no functions), and this module must not reach anything that
 * imports a Node builtin — the renderer compiles with `types: []`, so a stray
 * `node:fs` in the type graph is a compile error rather than a subtle one.
 *
 * The builder that fills these in is `src/core/view.ts`; the split is what
 * keeps both rules checkable.
 */

import type { Difficulty, ItemPosition, ItemSource } from '../core/save/types.js';

export type { Difficulty, ItemPosition, ItemSource };

/** One labelled run of stat lines — "base", `prefix "Thunderstruck"`, and so on. */
export interface UiStatBlock {
  heading?: string;
  lines: string[];
}

export interface UiSocketable {
  /**
   * The dossier id, when the document offered this socketable.
   *
   * A component has no save instance, so its identity is `shortHash(record)` —
   * the same id a plan writes in `targetId`. Carrying it here is what lets the
   * loadout render a *proposed* component with its real stats instead of the
   * bare name the plan happens to spell, and it is optional for the same reason
   * the plan's own field is: a socketable can be worn without being a candidate.
   */
  id?: string;
  name: string;
  lines: string[];
  /** Arc-relative `.tex` path, like an item's — components have their own art. */
  iconPath: string | null;
  /** Which slots the socketable may be applied to, already prose. */
  useOn?: string;
}

export interface UiTooltip {
  title: string;
  rarity: string;
  /** `Epic · ArmorProtective_Head · set: Deathmarked` — the identity line. */
  typeLine?: string;
  affixes: string[];
  blocks: UiStatBlock[];
  component?: UiSocketable;
  augment?: UiSocketable;
  /** Empty-socket notes are worth saying out loud: they are free upgrades. */
  sockets: string[];
  requirements?: string[];
  /** Whether the character currently meets them; undefined when unknown. */
  meetsRequirements?: boolean;
  grantedSkills: string[];
  /**
   * Which slots the item may be applied to, when the item *is* a socketable —
   * a component or augment sitting in a bag or the materials store. The same
   * line its chip shows when it is installed in something: where it can go is
   * the first question about a loose one.
   */
  useOn?: string;
  /** Records that did not resolve — a visible gap beats a silent one. */
  unresolved: string[];
}

export interface UiItem {
  /** The **document** id, so Stage 7B can join advice straight onto the grid. */
  docId: string;
  display: string;
  rarity: string;
  /** Arc-relative `.tex` path; the renderer turns it into a `gdicon://` URL. */
  iconPath: string | null;
  cellsW: number;
  cellsH: number;
  position: ItemPosition;
  source: ItemSource;
  stackCount: number;
  tooltip: UiTooltip;
}

export interface UiGrid {
  /** Tab / bag label, as the window's tab strip shows it. */
  label: string;
  width: number;
  height: number;
  items: UiItem[];
}

export interface UiAttribute {
  key: 'physique' | 'cunning' | 'spirit';
  label: string;
  base: number;
  flat: number;
  percent: number;
  total: number;
}

export interface UiResistRow {
  key: string;
  label: string;
  permanent: number;
  withMaintainable: number;
  /** Negative: the difficulty's own penalty, which is **not** uniform. */
  penalty: number;
  effective: number;
  cap: number;
}

export interface UiArmorSlot {
  slot: string;
  hitChance: number;
  piece: number;
  effective: number;
  /** The part most likely to let a big hit through. */
  weakest: boolean;
}

export interface UiSpeedLine {
  label: string;
  percent: number;
  percentWithMaintainable: number;
  cap: number;
  rate: number;
  rateWithMaintainable: number;
  /** Modifier points still worth adding; 0 means every further `+%` is wasted. */
  headroom: number;
  /** How far past the cap the character already is, if at all. */
  wasted: number;
  /** `attacks/s`, `casts/s` or `× base` — the rate's unit. */
  unit: string;
}

export interface UiStats {
  level: number;
  className: string;
  masteries: string[];
  difficulty: Difficulty;
  hardcore: boolean;
  iron: number;
  wielding: { mode: string; mainHand?: string; offHand?: string; enablers: string[] };
  attributes: UiAttribute[];
  /** From the save: what the character sheet's own Health/Energy bars read. */
  health: number;
  energy: number;
  /** Gear and skill contributions only, exactly as the aggregates report them. */
  healthBonus: { flat: number; percent: number };
  offensiveAbility: { flat: number; percent: number };
  defensiveAbility: { flat: number; percent: number };
  unspent: { attribute: number; skill: number; devotion: number };
  resistances: UiResistRow[];
  secondaryResistances: { label: string; value: number }[];
  armor: UiArmorSlot[];
  armorAverage: number;
  armorClasses: string[];
  armorBonus: { flat: number; percent: number };
  absorption: number;
  absorptionBase: number;
  block?: { chance: number; amount: number };
  speeds: UiSpeedLine[];
  /** What the numbers above leave out, carried through rather than implied. */
  exclusions: string[];
}

export interface UiSnapshot {
  character: string;
  savePath: string;
  gameVersion: string;
  difficulty: Difficulty;
  alternateWeaponSetActive: boolean;
  /** Length 12, in `EQUIP_SLOT_NAMES` order. */
  equipment: (UiItem | null)[];
  /** `[set 1, set 2]`, each `[main hand, off hand]`. */
  weaponSets: [(UiItem | null)[], (UiItem | null)[]];
  bags: UiGrid[];
  personalStash: UiGrid[];
  transferStash: UiGrid[];
  /** Loose components and crafting materials — a list, not a grid. */
  materials: UiItem[];
  /**
   * Every socketable the dossier offered, by its dossier id.
   *
   * The plan proposes components and augments by id, and a proposed one is
   * usually *not* installed anywhere yet — so there is no item to read its
   * stats off. This is that lookup, and it is a plain record because a `Map`
   * does not survive structured clone.
   */
  socketables: Record<string, UiSocketable>;
  stats: UiStats;
  /** Non-fatal problems from the parse, so the window can say so. */
  warnings: string[];
}
