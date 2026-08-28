/**
 * One projected swap per §7 candidate: the tool's subtraction, so the model's
 * reasoning is spent on the choice rather than the arithmetic.
 *
 * §7 used to print a candidate's absolute stats and nothing about the item it
 * would replace; every "swap this in → Acid drops 28 → under cap → what covers
 * it" was subtraction the model performed in reasoning tokens — and wall time
 * is output tokens. The evaluator already existed: `projectVerdicts` clones the
 * save, applies a verdict and re-aggregates, which is exactly what the
 * post-answer projection does for a whole plan. This runs it *before* the
 * answer, once per candidate per target slot, against the one aggregate the
 * document already printed.
 *
 * The doctrinal line, kept deliberately: a **projection is a fact about one
 * swap, printed whole; a score is a ranking.** Nothing here feeds `score` or
 * candidate order — filters.ts rejected a swap-simulating score as doing the
 * advisor's job, and it still does. `noTrackedGain` is an annotation, never a
 * cut, and it means exactly "no figure §3 counts moves up": procs, granted
 * skills, set-completion potential and the rest of §3's exclusion list are not
 * in it, and the document says so where it prints the flag.
 *
 * Everything degrades, nothing throws: a target that cannot be projected
 * carries a `skipped` reason and the line prints it.
 */

import type { DbItem, GameDb, StatValue } from '@grimdawn/core/db/types';
import type { AccountFiles, ResolvedCharacter, ResolvedItem } from '@grimdawn/core/resolve';
import { EQUIP_SLOT_NAMES, type CharacterSave } from '@grimdawn/core/save/types';
import type { PlanProjection } from '../ai/envelope.js';
import { projectVerdicts, type PlanVerdict } from '../ai/project.js';
import { aggregateCharacter, MELEE_1H, RANGED_1H, type CharacterAggregate } from '../mechanics/aggregate.js';
import { checkRequirements, type CharacterStanding, type RequirementCheck } from '../mechanics/requirements.js';
import { resistContributions, type ResistVector } from '../mechanics/stats.js';
import { itemConversions, type Candidate } from './filters.js';

/** A component or augment the outgoing item takes with it. */
export interface DepartingSocketable {
  kind: 'component' | 'augment';
  item: DbItem;
  /** What it contributed to the matrix — the part of the drop that is the socket, not the item. */
  resist: ResistVector;
  /** Component only: whether the candidate's own use-on flag accepts it. Undefined when the record states no restriction. */
  refits?: boolean;
  /** Augment only: where to buy another, as §9 prints it. Absent when no vendor the character has reached sells it. */
  rebuy?: string;
}

/** One candidate projected into one slot. */
export interface SlotProjection {
  /** The slot label the verdict would carry: `Ring 1`, `Weapon set 1 main`. */
  slot: string;
  /** What the slot holds today. */
  outgoing?: ResolvedItem;
  /** Anything else the swap takes out — the off hand a two-hander displaces. */
  alsoCleared: ResolvedItem[];
  projection?: PlanProjection;
  /** Why there is no projection, when there is none. */
  skipped?: string;
  departing: DepartingSocketable[];
  /** No figure the projection tracks moves up. An annotation, never a disposition. */
  noTrackedGain: boolean;
  /** Every tracked figure holds still. */
  identical: boolean;
  /**
   * The candidate checked against the loadout *without* the outgoing item —
   * the game's own equip-time check, since a reduction or `+Attribute` on
   * the outgoing piece leaves before the incoming one is judged. Present only
   * when it differs from the as-dressed check §7 already prints.
   */
  postSwap?: RequirementCheck;
  /** Worn items that no longer meet their requirements once the swap is made — an outgoing `+Cunning` un-wearing a third item. */
  unworn: string[];
  /** Sets whose worn piece count the swap moves (distinct members, as the game counts). */
  setPieces: { set: string; before: number; after: number }[];
  notes: string[];
}

export interface CandidateProjection {
  targets: SlotProjection[];
  /** True only when every target says so. */
  noTrackedGain: boolean;
}

export interface ProjectionsInput {
  save: CharacterSave;
  account?: AccountFiles | undefined;
  db: GameDb;
  /** The aggregate the document printed — the `before` of every projection. */
  aggregate: CharacterAggregate;
  resolved: ResolvedCharacter;
  /** Candidate → its dossier id, the builder's own map. */
  ids: ReadonlyMap<ResolvedItem, string>;
  /** Socketable record → its sourcing lines, as `socketableObtain` derives them. */
  obtain: ReadonlyMap<string, string[]>;
}

const SCALAR = (value: StatValue): number => (typeof value === 'number' ? value : 0);
const TWO_HANDED = /2h$/i;

/**
 * The use-on flag an item class answers to: `ArmorProtective_Waist` → `waist`,
 * `WeaponHunting_Ranged1h` → `ranged1h`. Mirrors `slotFlagForClass` in
 * verify.ts (the two vocabularies were built from the same 23 gear families);
 * restated here rather than imported so the context builder never depends on
 * the answer checker.
 */
export function useOnFlag(templateClass: string | undefined): string | undefined {
  const suffix = templateClass?.split('_')[1];
  return suffix ? suffix.toLowerCase() : undefined;
}

/** The slots a candidate could go into, as verdict labels. */
function targetsFor(candidate: Candidate, aggregate: CharacterAggregate): string[] {
  const set = aggregate.weaponSet;
  const cls = candidate.item.base?.slot ?? '';
  switch (candidate.group) {
    case 'Ring':
      return ['Ring 1', 'Ring 2'];
    case 'Main hand': {
      const main = `Weapon set ${set} main`;
      if (TWO_HANDED.test(cls)) return [main];
      // A one-hander on a dual-wielder is a candidate for either hand, the
      // way a ring is for either finger.
      const family = MELEE_1H.test(cls) ? 'melee' : cls === RANGED_1H ? 'ranged' : undefined;
      if (family && aggregate.wielding.mode === `dual-wield ${family}`) return [main, `Weapon set ${set} off`];
      return [main];
    }
    case 'Off hand':
      return [`Weapon set ${set} off`];
    default:
      return [candidate.group];
  }
}

/** The worn item at a verdict label, if any. */
function wornAt(slot: string, resolved: ResolvedCharacter, aggregate: CharacterAggregate): ResolvedItem | undefined {
  const index = EQUIP_SLOT_NAMES.indexOf(slot);
  const weapon = /^Weapon set (\d) (main|off)$/.exec(slot);
  return resolved.items.find((item) => {
    if (item.source !== 'equipped') return false;
    const p = item.position;
    if (index >= 0) return p.kind === 'equipment' && p.slot === index;
    if (weapon) return p.kind === 'weapon' && p.set === aggregate.weaponSet && p.hand === weapon[2];
    return false;
  });
}

/** A copy of the save with the named slots emptied — the loadout an equip-time check is made against. */
function withoutSlots(save: CharacterSave, slots: readonly string[]): CharacterSave {
  const copy = structuredClone(save);
  for (const slot of slots) {
    const index = EQUIP_SLOT_NAMES.indexOf(slot);
    if (index >= 0) {
      copy.equipment[index] = null;
      continue;
    }
    const weapon = /^Weapon set (\d) (main|off)$/.exec(slot);
    if (weapon) {
      const set = weapon[1] === '2' ? copy.weaponSet2 : copy.weaponSet1;
      set[weapon[2] === 'main' ? 0 : 1] = null;
    }
  }
  return copy;
}

function standingOf(aggregate: CharacterAggregate): CharacterStanding {
  return {
    level: aggregate.level,
    attributes: {
      physique: aggregate.attributes.physique.total,
      cunning: aggregate.attributes.cunning.total,
      spirit: aggregate.attributes.spirit.total,
    },
    reductions: aggregate.requirementReductions,
  };
}

function sameCheck(a: RequirementCheck, b: RequirementCheck): boolean {
  if (a.meets !== b.meets || a.gaps.length !== b.gaps.length) return false;
  return a.gaps.every((gap, i) => {
    const other = b.gaps[i];
    return other !== undefined && gap.attr === other.attr && gap.need === other.need && gap.have === other.have;
  });
}

/** Every (before, after) pair the projection tracks, for the gain/identity verdicts. */
function trackedPairs(p: PlanProjection): { before: number; after: number }[] {
  const pairs: { before: number; after: number }[] = [];
  for (const r of p.resistances) pairs.push({ before: r.before, after: r.after });
  for (const s of p.speeds) pairs.push({ before: s.before, after: s.after });
  for (const d of p.damage) {
    pairs.push({ before: d.percentBefore, after: d.percentAfter });
    pairs.push({ before: d.flatBefore, after: d.flatAfter });
  }
  pairs.push(p.totalDamagePercent);
  if (p.payload) pairs.push(p.payload);
  const d = p.defense;
  if (d) {
    pairs.push(
      { before: d.weakestPart.before, after: d.weakestPart.after },
      d.armorMean,
      d.absorption,
      d.offensiveAbility.flat,
      d.offensiveAbility.percent,
      d.defensiveAbility.flat,
      d.defensiveAbility.percent,
      d.health.flat,
      d.health.percent,
      d.attributes.physique,
      d.attributes.cunning,
      d.attributes.spirit,
    );
    if (d.sustain) pairs.push(d.sustain);
  }
  for (const r of p.skillRanks) pairs.push({ before: r.before, after: r.after });
  return pairs;
}

/** The secondary (uncapped) resistances, which the projection does not carry: read off the aggregates. */
function secondaryPairs(before: CharacterAggregate, after: CharacterAggregate): { before: number; after: number }[] {
  const b = new Map(before.resistances.secondary.map((s) => [s.label, s.value]));
  const a = new Map(after.resistances.secondary.map((s) => [s.label, s.value]));
  const labels = new Set([...b.keys(), ...a.keys()]);
  return [...labels].map((label) => ({ before: b.get(label) ?? 0, after: a.get(label) ?? 0 }));
}

/**
 * Worn piece counts for every set the swap touches. Counted here rather than
 * read off the aggregate because a set whose bonus carries no resistance has
 * no matrix row — and a broken set with no visible row is exactly the drop
 * that looks like a projection bug.
 */
function setPieceMoves(
  candidate: ResolvedItem,
  leaving: readonly ResolvedItem[],
  equipped: readonly ResolvedItem[],
  db: GameDb,
): SlotProjection['setPieces'] {
  const touched = new Set([candidate, ...leaving].map((i) => i.base?.setRecord).filter((r): r is string => !!r));
  const out: SlotProjection['setPieces'] = [];
  for (const record of touched) {
    const members = (items: readonly ResolvedItem[]): number =>
      new Set(items.filter((i) => i.base?.setRecord === record).map((i) => i.record)).size;
    const before = members(equipped);
    const after = members([...equipped.filter((i) => !leaving.includes(i)), candidate]);
    if (before !== after) out.push({ set: db.getSet(record)?.name ?? record, before, after });
  }
  return out;
}

/** Whether the item brings anything the projection cannot see: a grant, a conversion, a set. */
function carriesUntracked(item: ResolvedItem): boolean {
  if (item.base?.setRecord) return true;
  if (itemConversions(item).length) return true;
  const parts = [item.base, item.prefix, item.suffix, item.modifier, item.completion, item.component, item.augment];
  return parts.some((part) => part && Object.keys(part.stats).some((key) => /^augmentSkillName\d+$|^itemSkillName$/.test(key)));
}

/**
 * Project every candidate into every slot it could take, against the one
 * aggregate the document printed.
 */
export function candidateProjections(
  candidates: readonly Candidate[],
  input: ProjectionsInput,
): Map<ResolvedItem, CandidateProjection> {
  const { save, db, aggregate, resolved, obtain } = input;
  const account: AccountFiles = input.account ?? {};
  const itemsById = new Map<string, ResolvedItem>();
  for (const [item, id] of input.ids) itemsById.set(id, item);
  const projectionInput = {
    save,
    account,
    db,
    difficulty: aggregate.difficulty,
    itemsById,
    socketablesById: new Map<string, { record: string }>(),
  };

  // The equip-time standing per emptied slot set, shared by every candidate
  // of that slot: at most one extra aggregate per slot, not per candidate.
  const emptied = new Map<string, CharacterStanding | undefined>();
  const standingWithout = (slots: readonly string[]): CharacterStanding | undefined => {
    const key = slots.join('|');
    if (!emptied.has(key)) {
      try {
        emptied.set(key, standingOf(aggregateCharacter(withoutSlots(save, slots), db, aggregate.difficulty)));
      } catch {
        emptied.set(key, undefined);
      }
    }
    return emptied.get(key);
  };

  const equipped = resolved.items.filter((i) => i.source === 'equipped');
  const out = new Map<ResolvedItem, CandidateProjection>();
  for (const candidate of candidates) {
    const id = input.ids.get(candidate.item);
    const twoHanded = TWO_HANDED.test(candidate.item.base?.slot ?? '');
    const targets: SlotProjection[] = targetsFor(candidate, aggregate).map((slot) => {
      const outgoing = wornAt(slot, resolved, aggregate);
      const alsoCleared: ResolvedItem[] = [];
      const cleared = [slot];
      if (twoHanded && /main$/.test(slot)) {
        const off = wornAt(slot.replace(/main$/, 'off'), resolved, aggregate);
        if (off) {
          alsoCleared.push(off);
          cleared.push(slot.replace(/main$/, 'off'));
        }
      }

      const departing: DepartingSocketable[] = [];
      if (outgoing?.component) {
        const flag = useOnFlag(candidate.item.base?.slot);
        const allowed = outgoing.component.allowedSlots;
        departing.push({
          kind: 'component',
          item: outgoing.component,
          resist: resistContributions(outgoing.component.stats, SCALAR),
          ...(allowed && flag ? { refits: allowed.includes(flag) } : {}),
        });
      }
      if (outgoing?.augment) {
        const buy = obtain.get(outgoing.augment.record)?.find((line) => line.startsWith('Buy:'));
        departing.push({
          kind: 'augment',
          item: outgoing.augment,
          resist: resistContributions(outgoing.augment.stats, SCALAR),
          ...(buy ? { rebuy: buy.replace(/^Buy:\s*/, '') } : {}),
        });
      }

      const leaving = [...(outgoing ? [outgoing] : []), ...alsoCleared];
      const base: SlotProjection = {
        slot,
        ...(outgoing ? { outgoing } : {}),
        alsoCleared,
        departing,
        noTrackedGain: false,
        identical: false,
        unworn: [],
        setPieces: setPieceMoves(candidate.item, leaving, equipped, db),
        notes: [],
      };
      if (!id) return { ...base, skipped: 'the candidate has no dossier id' };

      const verdict: PlanVerdict = { slot, verdict: 'EQUIP', targetId: id, itemId: '', reason: '' };
      const result = projectVerdicts([verdict], projectionInput, { before: aggregate });
      if (!result) return { ...base, skipped: 'the aggregate could not be recomputed' };
      const { projection, after } = result;
      const skip = projection.skipped[0];
      if (skip) return { ...base, skipped: skip.reason };

      const pairs = [...trackedPairs(projection), ...secondaryPairs(aggregate, after)];
      const identical = pairs.every((p) => p.after === p.before);
      const noTrackedGain = !carriesUntracked(candidate.item) && pairs.every((p) => p.after <= p.before);

      const notes = [...projection.notes];
      if (
        after.wielding.mode.startsWith('dual-wield') &&
        after.wielding.enablers.length === 0 &&
        aggregate.wielding.permanentEnablers === 0
      ) {
        notes.push('removes the last dual-wield enabler — illegal as a single move');
      }

      const unworn = after.equippedRequirements
        .filter((e) => !e.check.meets && e.item !== candidate.item.display)
        .map((e) => `${e.item} (${e.slot})`);

      const standing = standingWithout(cleared);
      const postSwap = standing ? checkRequirements(candidate.item, standing) : undefined;

      return {
        ...base,
        projection,
        noTrackedGain,
        identical,
        ...(postSwap && !sameCheck(postSwap, candidate.check) ? { postSwap } : {}),
        unworn,
        notes,
      };
    });
    out.set(candidate.item, {
      targets,
      noTrackedGain: targets.length > 0 && targets.every((t) => t.projection !== undefined && t.noTrackedGain),
    });
  }
  return out;
}
