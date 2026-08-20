/**
 * Applying the game's faction reputation boosters to a character.
 *
 * Grim Dawn sells three consumables that multiply reputation change — a Writ
 * (×1.5), a Mandate (×3) and, for hostile factions, a Warrant (×3, which speeds
 * the slide to Nemesis). Each is bought per faction, for 15k–100k iron, and used
 * one at a time. The effect they leave behind is two floats per faction slot in
 * block 13: `positiveBoost` and `negativeBoost`. So this writes the effect
 * rather than the items — no inventory encoder, nothing to right-click in game.
 *
 * The multipliers are not written here. `db.factionBoosters()` reads them off
 * the records, and the target is the **largest** one offered per faction per
 * direction: the Mandate's own description says it does not stack with Writs, so
 * a booster's value replaces rather than adds, and "all of them" means the best
 * of them. Nothing is hardcoded to 3 — a patch that adds a fourth tier is picked
 * up by the same rule.
 *
 * Sibling of `mastery.ts`, and deliberately shaped like it: plan, refuse rather
 * than repair, and hand back edited bytes only when nothing stands in the way.
 */

import type { DbFactionBooster, GameDb } from '../db/types.js';
import { saveEditRefusals, type SaveEditRefusal } from './edit.js';
import { factionSlot, factionSlotByKey } from './factions.js';
import { encodeBlock13 } from './gdc.js';
import { replay, spliceRegion, type Seg, type Transcript } from './transcript.js';
import type { CharacterSave, FactionRep } from './types.js';

/** Which of the save's two multipliers a booster sets. */
export type BoosterKind = 'reputation' | 'nemesis';

export interface BoosterChange {
  /** Faction slot — the identity; the save stores no names. */
  slot: number;
  faction: string;
  kind: BoosterKind;
  /** 0, or 1.5 where a Writ has already been used on this character. */
  from: number;
  to: number;
  /** The item the game would have sold to do this, e.g. "Mandate of the Rovers". */
  source: string;
}

export type BoosterRefusal =
  | SaveEditRefusal
  /** The database knows no boosters at all — wrong game directory, or a mod. */
  | { kind: 'no-boosters' }
  | { kind: 'unknown-faction'; name: string };

export interface BoosterPlan {
  character: string;
  /** What would be written. Empty means the character already has all of it. */
  changes: BoosterChange[];
  /** Already at the target value; printed so the total is legible, not written. */
  unchanged: BoosterChange[];
  /** A `boostedFaction` key with no slot in this save — reported, never silent. */
  skipped: { key: string; name: string; reason: string }[];
  refusals: BoosterRefusal[];
  /** The edited file, when there is something to write and nothing stopping it. */
  output?: Buffer;
}

export interface BoosterPlanInput {
  character: string;
  save: CharacterSave;
  transcript: Transcript;
  /** The bytes the save was parsed from, for the round-trip check. */
  source: Buffer;
  db: GameDb;
  /** Writs and Mandates — `positiveBoost`. Default true. */
  writs?: boolean;
  /** Warrants — `negativeBoost`. Default true. */
  warrants?: boolean;
  /** Only these factions: a slot number, a faction id, or a name. */
  factions?: string[];
  /** Set the targeted multipliers back to 0 instead of applying them. */
  clear?: boolean;
}

interface Target {
  to: number;
  source: string;
}

/**
 * The best booster per faction slot per direction.
 *
 * Grouping is by *slot* rather than by the record's `boostedFaction` key so that
 * the four factions carrying both a Writ and a Warrant — the ones the game lets
 * you side against — land on one entry with both directions filled.
 */
export function bestBoosters(boosters: readonly DbFactionBooster[], slotOf: (key: string) => number | undefined): {
  targets: Map<number, Partial<Record<BoosterKind, Target>>>;
  unmapped: DbFactionBooster[];
} {
  const targets = new Map<number, Partial<Record<BoosterKind, Target>>>();
  const unmapped: DbFactionBooster[] = [];
  for (const b of boosters) {
    const slot = slotOf(b.factionKey);
    if (slot === undefined) {
      unmapped.push(b);
      continue;
    }
    const entry = targets.get(slot) ?? {};
    const current = entry[b.kind];
    if (!current || b.multiplier > current.to) entry[b.kind] = { to: b.multiplier, source: b.name };
    targets.set(slot, entry);
  }
  return { targets, unmapped };
}

/** Localized faction names, by slot, with the save's own table as the fallback. */
function factionNames(db: GameDb): Map<number, string> {
  const byId = new Map(db.factions().map((f) => [f.id, f.name]));
  const out = new Map<number, string>();
  for (let slot = 0; slot < 64; slot++) {
    const s = factionSlot(slot);
    if (s) out.set(slot, byId.get(s.id) ?? s.name);
  }
  return out;
}

/** Does this `--faction` argument name that slot? Number, id, or name. */
function matchesFilter(slot: number, name: string, filter: string): boolean {
  const wanted = filter.trim().toLowerCase();
  if (wanted === String(slot)) return true;
  if (factionSlot(slot)?.id === wanted) return true;
  return name.toLowerCase() === wanted;
}

/**
 * Work out what applying every booster would do. The edited bytes come back on
 * `output` only when `refusals` is empty and something actually changes.
 */
export function planFactionBoosters(input: BoosterPlanInput): BoosterPlan {
  const { character, save, transcript, source, db } = input;
  const writs = input.writs !== false;
  const warrants = input.warrants !== false;
  const refusals: BoosterRefusal[] = [];

  const names = factionNames(db);
  const { targets, unmapped } = bestBoosters(db.factionBoosters(), factionSlotByKey);
  const skipped = unmapped.map((b) => ({
    key: b.factionKey,
    name: b.name,
    reason: `no faction slot for "${b.factionKey}"`,
  }));

  const changes: BoosterChange[] = [];
  const unchanged: BoosterChange[] = [];
  const matched = new Set<string>();

  const after: FactionRep[] = save.factions.map((f) => ({ ...f }));
  for (const [slot, entry] of [...targets].sort((a, b) => a[0] - b[0])) {
    const rep = after[slot];
    const name = names.get(slot) ?? `faction ${slot}`;
    if (!rep) {
      const worst = entry.reputation ?? entry.nemesis;
      skipped.push({
        key: name,
        name: worst?.source ?? name,
        reason: `slot ${slot} is beyond this save's ${save.factions.length} faction slots`,
      });
      continue;
    }
    if (input.factions?.length) {
      const hit = input.factions.find((f) => matchesFilter(slot, name, f));
      if (!hit) continue;
      matched.add(hit);
    }

    for (const kind of ['reputation', 'nemesis'] as const) {
      const target = entry[kind];
      if (!target) continue;
      if (kind === 'reputation' && !writs) continue;
      if (kind === 'nemesis' && !warrants) continue;

      const field = kind === 'reputation' ? 'positiveBoost' : 'negativeBoost';
      const from = rep[field];
      const to = input.clear ? 0 : target.to;
      const change: BoosterChange = { slot, faction: name, kind, from, to, source: target.source };
      if (from === to) {
        unchanged.push(change);
        continue;
      }
      rep[field] = to;
      changes.push(change);
    }
  }

  if (!targets.size) refusals.push({ kind: 'no-boosters' });
  for (const f of input.factions ?? []) {
    if (!matched.has(f)) refusals.push({ kind: 'unknown-faction', name: f });
  }
  refusals.push(...saveEditRefusals(save, transcript, source));

  const plan: BoosterPlan = { character, changes, unchanged, skipped, refusals };
  if (!refusals.length && changes.length) {
    try {
      plan.output = buildEditedSave(save, { ...save, factions: after }, transcript);
    } catch (err) {
      refusals.push({ kind: 'encoder-prefix-mismatch', detail: (err as Error).message });
    }
  }
  return plan;
}

/**
 * Splice the edited faction block in and re-encipher.
 *
 * Block 13 is the only region that moves, and `spliceRegion` requires the
 * encoder to reproduce the *unedited* block field for field before the edited
 * one may replace it — an encoder that has drifted from its decoder throws here
 * instead of writing a plausible-looking wrong file.
 */
function buildEditedSave(save: CharacterSave, after: CharacterSave, transcript: Transcript): Buffer {
  const segments = [...transcript.segments];
  const at = segments.findIndex((s) => s.kind === 'block' && s.id === 13);
  if (at < 0) throw new Error('block 13: not in this save');
  const block = segments[at]!;
  if (block.kind !== 'block') throw new Error('block 13: not a block');
  const version = versionOf(block.body);
  segments[at] = {
    kind: 'block',
    id: 13,
    body: spliceRegion(block.body, encodeBlock13(save, version), encodeBlock13(after, version), 'block 13'),
  };
  return replay({ ...transcript, segments });
}

/** Every block body starts with its version word. */
function versionOf(body: Seg[]): number {
  const first = body[0];
  if (first?.kind !== 'u32') throw new Error('block 13: body does not start with a version word');
  return first.value;
}
