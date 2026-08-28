/**
 * The tool-computed before→after of a plan.
 *
 * `aggregateCharacter(save, db, difficulty)` is a pure function of the save, so
 * the honest projection is mechanical: apply the plan's verdicts to a *copy* of
 * the save the run saw, re-aggregate, and diff. That includes the one thing a
 * model cannot do from the dossier — gear `+skills` moving effective skill
 * ranks, which re-reads every per-rank array — and it is why a live gpt-5.6 run
 * honestly refused to project attack speed. `effectiveRanks` runs inside the
 * aggregate, so rank shifts come for free.
 *
 * Sits beside `verify.ts` because it is the same kind of thing: a mechanical
 * computation over (plan × dossier index × database). It may import the
 * resolver, the save types and the mechanics — `envelope.ts`, which carries the
 * result, may not.
 *
 * Everything degrades, nothing throws: a verdict that cannot be applied lands in
 * `skipped` with a reason, and a projection that cannot be computed at all
 * returns undefined — the envelope field is simply absent.
 */

import type { GameDb } from '@grimdawn/core/db/types';
import { aggregateCharacter, type CharacterAggregate } from '../mechanics/aggregate.js';
import { RESIST_COLUMNS } from '../mechanics/stats.js';
import { weaponSlotRef } from '../../shared/slots.js';
import type { AccountFiles, ResolvedItem } from '@grimdawn/core/resolve';
import {
  EQUIP_SLOT_NAMES,
  type CharacterSave,
  type Difficulty,
  type EquippedItem,
  type ItemInstance,
} from '@grimdawn/core/save/types';
import type { PlanProjection } from './envelope.js';
import type { AdvisorPlan, SocketFit, Verdict } from './provider.js';

/** A socketable the projection can install: the dossier's id → its record path. */
export interface ProjectionInput {
  /** The save the run saw — the projection is a fact about *that* loadout. */
  save: CharacterSave;
  /** Transfer-stash instances live here, not in the save. */
  account: AccountFiles;
  db: GameDb;
  /** The difficulty the dossier was written for, so before matches §3. */
  difficulty: Difficulty;
  /** Dossier item id → resolved item (`doc.itemsById`). */
  itemsById: ReadonlyMap<string, ResolvedItem>;
  /** Dossier socketable id → its DbItem (`doc.socketablesById`). */
  socketablesById: ReadonlyMap<string, { record: string }>;
}

type SlotRef = { kind: 'equipment'; index: number } | { kind: 'weapon'; set: 1 | 2; hand: 0 | 1 };

/**
 * Aliases (`Main hand`, `weapon 1 off`) resolve through the shared matcher,
 * against the active set — which is why this needs `activeSet` and lives on the
 * far side of the "recognized vs `skipped`" line: an alias is a vocabulary
 * miss and is normalized silently; a genuinely unknown label still degrades.
 */
function slotRef(slot: string, activeSet: 1 | 2): SlotRef | undefined {
  const trimmed = slot.trim().toLowerCase();
  const index = EQUIP_SLOT_NAMES.findIndex((name) => name.toLowerCase() === trimmed);
  if (index >= 0) return { kind: 'equipment', index };
  const weapon = weaponSlotRef(slot, activeSet);
  if (weapon) return { kind: 'weapon', set: weapon.set, hand: weapon.hand };
  return undefined;
}

function slotInstance(save: CharacterSave, ref: SlotRef): EquippedItem | null {
  if (ref.kind === 'equipment') return save.equipment[ref.index] ?? null;
  const set = ref.set === 1 ? save.weaponSet1 : save.weaponSet2;
  return set[ref.hand] ?? null;
}

function setSlotInstance(save: CharacterSave, ref: SlotRef, item: EquippedItem | null): void {
  if (ref.kind === 'equipment') save.equipment[ref.index] = item;
  else (ref.set === 1 ? save.weaponSet1 : save.weaponSet2)[ref.hand] = item;
}

/**
 * The raw saved instance behind a resolved item, located through its structured
 * position. Positions refer to the save as parsed, so this must run against the
 * *original* save/account, never the mutated copy.
 */
function rawInstance(item: ResolvedItem, save: CharacterSave, account: AccountFiles): ItemInstance | undefined {
  const p = item.position;
  switch (p.kind) {
    case 'equipment':
      return save.equipment[p.slot] ?? undefined;
    case 'weapon': {
      const set = p.set === 1 ? save.weaponSet1 : save.weaponSet2;
      return set[p.hand === 'main' ? 0 : 1] ?? undefined;
    }
    case 'inventory':
      return save.inventorySacks[p.sack]?.find((it) => it.x === p.x && it.y === p.y && it.baseName === item.record);
    case 'stash':
      return save.personalStash[p.tab]?.items.find(
        (it) => Math.round(it.x) === p.x && Math.round(it.y) === p.y && it.baseName === item.record,
      );
    case 'transfer':
      return account.stash?.sacks[p.tab]?.items.find(
        (it) => Math.round(it.x) === p.x && Math.round(it.y) === p.y && it.baseName === item.record,
      );
    case 'materials':
      // Synthetic instance — a reagent-store row is not equippable gear.
      return undefined;
  }
}

/** An `EquippedItem` from any raw instance: grid coordinates do not survive. */
function asEquipped(inst: ItemInstance): EquippedItem {
  const { x: _x, y: _y, ...rest } = inst as ItemInstance & { x?: number; y?: number };
  return { ...rest, attached: true };
}

const SOCKET_VERDICT_KINDS: Readonly<Partial<Record<Verdict, 'component' | 'augment'>>> = {
  'ADD-COMPONENT': 'component',
  'SWAP-COMPONENT': 'component',
  'RE-AUGMENT': 'augment',
  'BUY-AUGMENT': 'augment',
};

export type PlanVerdict = AdvisorPlan['verdicts'][number];

/** A projection with the two aggregates it was diffed from. */
export interface Projected {
  projection: PlanProjection;
  before: CharacterAggregate;
  after: CharacterAggregate;
}

/** A two-handed weapon class: `WeaponMelee_Sword2h`, `WeaponHunting_Ranged2h`, the spear. */
const TWO_HANDED = /2h$/i;

/** The whole plan: its verdicts projected, plus where the model's own tally disagrees. */
export function projectPlan(plan: AdvisorPlan, input: ProjectionInput): PlanProjection | undefined {
  const result = projectVerdicts(plan.verdicts, input);
  if (!result) return undefined;
  noteModelDisagreements(plan, result.projection);
  return result.projection;
}

/**
 * Any list of verdicts against the save the run saw — the plan's, or a single
 * synthetic `EQUIP` when the context builder projects one candidate swap.
 *
 * `opts.before` is the aggregate to diff against when the caller already holds
 * it; the builder projects a hundred candidates against one loadout and must
 * not recompute that loadout a hundred times. Absent, it is recomputed here so
 * before and after are guaranteed to be the same arithmetic over the same
 * inputs.
 */
export function projectVerdicts(
  verdicts: readonly PlanVerdict[],
  input: ProjectionInput,
  opts: { before?: CharacterAggregate } = {},
): Projected | undefined {
  const { save, account, db, difficulty, itemsById, socketablesById } = input;

  const skipped: PlanProjection['skipped'] = [];
  const notes: string[] = [];
  const note = (text: string): void => {
    if (!notes.includes(text)) notes.push(text);
  };

  let before: CharacterAggregate;
  try {
    before = opts.before ?? aggregateCharacter(save, db, difficulty);
  } catch {
    return undefined;
  }

  const mutated = structuredClone(save);
  const activeSet: 1 | 2 = save.alternateWeaponSetActive ? 2 : 1;
  let componentInstalls = 0;

  const install = (ref: SlotRef, slot: string, verdict: string, kind: 'component' | 'augment', id: string): void => {
    const socketable = socketablesById.get(id);
    if (!socketable) {
      skipped.push({ slot, verdict, reason: `socketable id ${id} is not in the dossier` });
      return;
    }
    const inst = slotInstance(mutated, ref);
    if (!inst) {
      skipped.push({ slot, verdict, reason: 'the slot is empty in the loadout the run saw' });
      return;
    }
    if (kind === 'component') {
      inst.relicName = socketable.record;
      inst.relicSeed = 0;
      inst.relicBonus = '';
      inst.relicCompletionLevel = 1;
      componentInstalls++;
    } else {
      inst.augmentName = socketable.record;
      inst.augmentSeed = 0;
    }
  };

  /** The class of whatever a weapon slot holds right now, in the mutated save. */
  const heldClass = (ref: SlotRef): string | undefined => {
    const inst = slotInstance(mutated, ref);
    return inst ? db.getItem(inst.baseName)?.slot : undefined;
  };

  for (const verdict of verdicts) {
    try {
      applyVerdict(verdict);
    } catch (err) {
      skipped.push({ slot: verdict.slot, verdict: verdict.verdict, reason: (err as Error).message });
    }
  }

  function applyVerdict(verdict: PlanVerdict): void {
    const ref = slotRef(verdict.slot, activeSet);
    if (!ref) {
      skipped.push({ slot: verdict.slot, verdict: verdict.verdict, reason: 'unrecognized slot label' });
      return;
    }
    if (ref.kind === 'weapon' && ref.set !== activeSet) {
      note('changes to the inactive weapon set are applied but do not move these figures — the aggregate covers the held set only');
    }

    // An extraction destroys its host: a worn host leaves the loadout.
    if (verdict.componentFrom) {
      const host = itemsById.get(verdict.componentFrom);
      if (host && (host.position.kind === 'equipment' || host.position.kind === 'weapon')) {
        const hostRef: SlotRef =
          host.position.kind === 'equipment'
            ? { kind: 'equipment', index: host.position.slot }
            : { kind: 'weapon', set: host.position.set, hand: host.position.hand === 'main' ? 0 : 1 };
        setSlotInstance(mutated, hostRef, null);
        note(`extracting a component destroys its host: ${host.display} leaves the loadout`);
      }
    }

    switch (verdict.verdict) {
      case 'KEEP':
        break;
      case 'EQUIP': {
        const id = verdict.targetId ?? verdict.target ?? '';
        const target = itemsById.get(id) ?? (verdict.target ? itemsById.get(verdict.target) : undefined);
        if (!target) {
          skipped.push({ slot: verdict.slot, verdict: 'EQUIP', reason: `item id ${id || '(none)'} is not in the dossier` });
          break;
        }
        const inst = rawInstance(target, save, account);
        if (!inst) {
          skipped.push({ slot: verdict.slot, verdict: 'EQUIP', reason: `no saved instance found for ${target.display}` });
          break;
        }
        // Hands are not independent slots. A two-hander takes both, so the off
        // hand empties with it; and nothing goes *into* the off hand while a
        // two-hander is held — that is a pairing the plan has to make as one
        // move with a one-hander in the main hand.
        if (ref.kind === 'weapon') {
          const incoming2h = TWO_HANDED.test(target.base?.slot ?? '');
          const mainRef: SlotRef = { kind: 'weapon', set: ref.set, hand: 0 };
          const offRef: SlotRef = { kind: 'weapon', set: ref.set, hand: 1 };
          if (ref.hand === 1 && incoming2h) {
            skipped.push({ slot: verdict.slot, verdict: 'EQUIP', reason: 'a two-hander cannot go in the off hand' });
            break;
          }
          if (ref.hand === 1 && TWO_HANDED.test(heldClass(mainRef) ?? '')) {
            skipped.push({ slot: verdict.slot, verdict: 'EQUIP', reason: 'a two-hander is held; pair it with a one-hander in the main hand as one move' });
            break;
          }
          if (ref.hand === 0 && incoming2h) {
            const off = slotInstance(mutated, offRef);
            if (off) {
              const name = db.getItem(off.baseName)?.name ?? off.baseName;
              setSlotInstance(mutated, offRef, null);
              note(`${target.display} takes both hands: ${name} leaves the loadout with the off hand`);
            }
          }
        }
        // Wearing it in this slot must not leave a second copy where it came
        // from — a Ring 1 ↔ Ring 2 shuffle would otherwise count it twice.
        if (target.position.kind === 'equipment') setSlotInstance(mutated, { kind: 'equipment', index: target.position.slot }, null);
        else if (target.position.kind === 'weapon') {
          setSlotInstance(mutated, { kind: 'weapon', set: target.position.set, hand: target.position.hand === 'main' ? 0 : 1 }, null);
        }
        setSlotInstance(mutated, ref, asEquipped(inst));
        break;
      }
      case 'ADD-COMPONENT':
      case 'SWAP-COMPONENT':
      case 'RE-AUGMENT':
      case 'BUY-AUGMENT': {
        const kind = SOCKET_VERDICT_KINDS[verdict.verdict]!;
        // Replacing an installed component removes the augment too; a `fits`
        // entry re-states it when the plan means to re-apply it.
        if (verdict.verdict === 'SWAP-COMPONENT') {
          const inst = slotInstance(mutated, ref);
          if (inst) {
            inst.augmentName = '';
            inst.augmentSeed = 0;
          }
        }
        const id = verdict.targetId ?? '';
        if (!id) {
          skipped.push({ slot: verdict.slot, verdict: verdict.verdict, reason: 'the verdict names no socketable id' });
          break;
        }
        install(ref, verdict.slot, verdict.verdict, kind, id);
        break;
      }
      case 'CRAFT':
        skipped.push({ slot: verdict.slot, verdict: 'CRAFT', reason: 'the item is transformed; the result is not projectable' });
        break;
    }

    for (const fit of verdict.fits ?? []) applyFit(fit, ref, verdict.slot, verdict.verdict, install);
  }

  if (componentInstalls) {
    note('freshly installed components are projected without a rolled completion bonus — a slight understatement');
  }

  let after: CharacterAggregate;
  try {
    after = aggregateCharacter(mutated, db, difficulty);
  } catch {
    return undefined;
  }

  return { projection: diff(before, after, skipped, notes), before, after };
}

/**
 * Where the model also projected a resistance, disagreement is worth a line —
 * display-only here: the one disagreement that is a plan error rather than a
 * reporting choice (tally claims capped, computed lands under cap) is
 * `overstated-cap` in verify.ts, which projects through the same code inside
 * the repair loop. A figure matching *either* band within ±2 is a
 * reporting-band choice, not a disagreement: the first live A/B produced
 * three notes that were all opus stating the permanent band, and a note that
 * fires on that means nothing.
 */
function noteModelDisagreements(plan: AdvisorPlan, projection: PlanProjection): void {
  for (const row of projection.resistances) {
    const modelValue = modelResistance(plan, row.label);
    if (
      modelValue !== undefined &&
      Math.abs(modelValue - row.after) > 2 &&
      Math.abs(modelValue - (row.afterPermanent ?? row.after)) > 2
    ) {
      projection.notes.push(
        `the model projected ${row.label} Resistance at ${modelValue}; the computed figure is ${row.after} ` +
          `(${row.afterPermanent} permanent-band)`,
      );
    }
  }
}

function applyFit(
  fit: SocketFit,
  ref: SlotRef,
  slot: string,
  verdict: string,
  install: (ref: SlotRef, slot: string, verdict: string, kind: 'component' | 'augment', id: string) => void,
): void {
  install(ref, slot, `${verdict} (fits)`, fit.kind, fit.id);
}

function diff(
  before: CharacterAggregate,
  after: CharacterAggregate,
  skipped: PlanProjection['skipped'],
  notes: string[],
): PlanProjection {
  const round = (n: number): number => Math.round(n * 10) / 10;

  const resistances = RESIST_COLUMNS.map((column) => ({
    label: column.label,
    before: round(before.resistances.effective[column.key] ?? 0),
    after: round(after.resistances.effective[column.key] ?? 0),
    // The permanent band under the same penalty — what a model reporting
    // "buffs as pure overcap buffer" is actually stating.
    afterPermanent: round(
      (after.resistances.permanent[column.key] ?? 0) + (after.resistances.penalty[column.key] ?? 0),
    ),
    capAfter: round(after.resistances.caps[column.key] ?? 0),
  }));

  const speeds: PlanProjection['speeds'] = (
    [
      ['attack', before.speed.attack, after.speed.attack],
      ['cast', before.speed.cast, after.speed.cast],
      ['movement', before.speed.movement, after.speed.movement],
    ] as const
  ).map(([key, b, a]) => ({ key, label: b.label, before: round(b.percent), after: round(a.percent) }));

  const damageKeys = new Map<string, { label: string; overTime: boolean }>();
  for (const entry of [...before.damage.ranked, ...after.damage.ranked]) {
    damageKeys.set(entry.key, { label: entry.label, overTime: entry.overTime });
  }
  const entryFor = (agg: CharacterAggregate, key: string) => agg.damage.ranked.find((e) => e.key === key);
  const damage = [...damageKeys]
    .map(([key, meta]) => ({
      key,
      label: meta.label,
      overTime: meta.overTime,
      percentBefore: entryFor(before, key)?.percent ?? 0,
      percentAfter: entryFor(after, key)?.percent ?? 0,
      flatBefore: entryFor(before, key)?.flat ?? 0,
      flatAfter: entryFor(after, key)?.flat ?? 0,
    }))
    .sort((a, b) => b.percentAfter - a.percentAfter || b.flatAfter - a.flatAfter);

  const ranksBefore = new Map(before.ranks.map((r) => [r.record, r]));
  const skillRanks: PlanProjection['skillRanks'] = [];
  for (const rank of after.ranks) {
    const prior = ranksBefore.get(rank.record);
    if (prior && prior.effective !== rank.effective) {
      skillRanks.push({ skill: rank.name, before: prior.effective, after: rank.effective });
    }
  }

  // The defence and attribute block, straight off the two aggregates — what
  // both live A/B models were hand-computing in prose notes. Same "contributions
  // only" boundary as §3: the engine's OA/DA/health base stays unmodelled.
  const pair = (b: number, a: number): { before: number; after: number } => ({ before: round(b), after: round(a) });
  const defense: PlanProjection['defense'] = {
    weakestPart: {
      slotBefore: before.defense.weakestSlot?.slot ?? '',
      slotAfter: after.defense.weakestSlot?.slot ?? '',
      before: round(before.defense.weakestSlot?.effective ?? 0),
      after: round(after.defense.weakestSlot?.effective ?? 0),
    },
    armorMean: pair(before.defense.armorAverage, after.defense.armorAverage),
    absorption: pair(before.defense.absorption, after.defense.absorption),
    offensiveAbility: {
      flat: pair(before.attributes.offensiveAbility.flat, after.attributes.offensiveAbility.flat),
      percent: pair(before.attributes.offensiveAbility.percent, after.attributes.offensiveAbility.percent),
    },
    defensiveAbility: {
      flat: pair(before.attributes.defensiveAbility.flat, after.attributes.defensiveAbility.flat),
      percent: pair(before.attributes.defensiveAbility.percent, after.attributes.defensiveAbility.percent),
    },
    health: {
      flat: pair(before.defense.health, after.defense.health),
      percent: pair(before.defense.healthPercent, after.defense.healthPercent),
    },
    sustain: pair(before.defense.lifeLeechPercent, after.defense.lifeLeechPercent),
    attributes: {
      physique: pair(before.attributes.physique.total, after.attributes.physique.total),
      cunning: pair(before.attributes.cunning.total, after.attributes.cunning.total),
      spirit: pair(before.attributes.spirit.total, after.attributes.spirit.total),
    },
  };

  return {
    resistances,
    speeds,
    damage,
    totalDamagePercent: { before: before.damage.totalDamagePercent, after: after.damage.totalDamagePercent },
    payload: pair(before.damage.payloadIndex, after.damage.payloadIndex),
    defense,
    skillRanks,
    skipped,
    notes,
  };
}

/** The plan's own projection for a §3 label, tolerant of case. */
function modelResistance(plan: AdvisorPlan, label: string): number | undefined {
  const projected = plan.projectedResistances;
  if (!projected) return undefined;
  for (const [key, value] of Object.entries(projected)) {
    if (key.toLowerCase() === label.toLowerCase()) return value;
  }
  return undefined;
}
