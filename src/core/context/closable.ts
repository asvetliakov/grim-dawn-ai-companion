/**
 * Is the resistance gap a swap opens closable by re-assigning the loadout's
 * armour augment sockets and the incoming item's own component socket?
 *
 * The live run this exists for held a pair of boots "until an on-focus Ring
 * or Amulet carrying ≥13% Acid Resistance" — a gap that a Venomguard Powder
 * on the belt and an Antivenom Salve in the boots' own socket closed the next
 * day, once the user had put the boots on anyway. The model had the levers
 * table in front of it and never composed the move: a candidate's line said
 * `33 under cap`, and nothing on the line said whether that was closable.
 *
 * So this computes one **witness**: a concrete assignment that puts every
 * cappable resistance back at cap (or where it was, for one that was already
 * short before the swap), or the statement that none exists within these
 * means. It is a fact printed whole, not a recommendation and not a ranking —
 * nothing here feeds `score` or candidate order, and the search deliberately
 * touches only what is not a damage judgement:
 *
 * - **armour augments** (head, shoulders, chest, hands, legs, feet, belt) —
 *   in the installed database every one of them is resistance lines plus, on
 *   ten of thirty-nine, a defensive side line (Defensive Ability, health,
 *   armour, regeneration); none carries damage, Offensive Ability, `+skills`
 *   or `+% Maximum Resistance`, so swapping one moves no cap, no rank and no
 *   damage figure and the arithmetic below is exact;
 * - **the incoming item's component socket**, when it is empty or holds the
 *   carried-over component — never a component the candidate was saved with
 *   (replacing that destroys it), and never another worn item's component.
 *
 * Jewellery and weapon augments carry damage and Offensive Ability and stay
 * the model's call, as do joint moves with other candidates — which is why
 * "not closable" is scoped in the document to *by these means*.
 *
 * The search under-claims only: it prints `closable` with an assignment in
 * hand, and the caller verifies that assignment against a real aggregate
 * before printing it. Greedy first (largest shortfall reduction per move,
 * never deepening or opening another gap), then a bounded depth-first search
 * when greedy stalls — seven sockets by a dozen augments is small.
 */

import type { DbItem, StatValue } from '@grimdawn/core/db/types';
import { RESIST_COLUMNS, resistContributions, type ResistKey, type ResistVector } from '../mechanics/stats.js';

/** The verdict labels of the slots whose augments are pure resistance lines. */
export const ARMOUR_SLOTS: readonly string[] = ['Head', 'Shoulders', 'Chest', 'Hands', 'Legs', 'Feet', 'Belt'];

const CAPPABLE = RESIST_COLUMNS.filter((c) => c.key !== 'physical');
const SCALAR = (value: StatValue): number => (typeof value === 'number' ? value : 0);
/**
 * DFS node budget for one `findClosable` call, shared across its component
 * options. Seven sockets by a couple of dozen augments is 26^7 arrangements —
 * no budget makes this exhaustive, so the cap is a time bound, not a
 * completeness one, and exhausting it means `not closable`: an under-claim,
 * which is the direction this is allowed to be wrong in. Measured at ~30 µs a
 * node, so this bounds one slot's search at ~120 ms even when nothing closes,
 * and the greedy pass above answers the ordinary case without entering here.
 */
const NODE_CAP = 4_000;

/** An augment that can be had: loose on hand, or bought at a reached tier. */
export interface AugmentOption {
  item: DbItem;
  /** `loose`, or the vendor line as §9 prints it. */
  source: string;
  iron: number;
}

export interface ComponentOption {
  item: DbItem;
  source: 'loose' | 'craftable';
}

/** One armour augment socket of the post-swap loadout. */
export interface ArmourSocket {
  slot: string;
  /** The use-on flag of the item in it. */
  flag: string | undefined;
  /** What the socket holds after the swap (the carried-over augment, on the target slot). */
  augment?: DbItem;
}

/** The incoming item's component socket, when its contents may be chosen. */
export interface ComponentSocket {
  slot: string;
  flag: string | undefined;
  /** What the projection carried into it, if anything. */
  current?: DbItem;
}

export interface ClosableInput {
  /** Effective resistances before the swap — the loadout §3 printed. */
  before: ResistVector;
  /** Effective resistances after the like-for-like swap. */
  after: ResistVector;
  caps: ResistVector;
  sockets: readonly ArmourSocket[];
  /** Absent when the candidate's socket is saved full — a saved component is not a variable. */
  target?: ComponentSocket;
  augments: readonly AugmentOption[];
  components: readonly ComponentOption[];
}

export interface OpenedGap {
  key: ResistKey;
  label: string;
  /** Points short of the target — the cap, or the pre-swap figure when that was already below it. */
  short: number;
}

export interface Reaugment {
  slot: string;
  augment: AugmentOption;
  replaces?: DbItem;
}

export interface ComponentFill {
  component: ComponentOption;
  displaces?: DbItem;
}

export interface ClosableWitness {
  reaugments: Reaugment[];
  fill?: ComponentFill;
  iron: number;
  /** The effective vector the arithmetic predicts — what the caller verifies against a real aggregate. */
  predicted: ResistVector;
}

export function resistOf(item: DbItem | undefined): ResistVector {
  return item ? resistContributions(item.stats, SCALAR) : {};
}

/** A socketable's use-on restriction accepts the flag (or records none). */
export function fitsFlag(item: DbItem, flag: string | undefined): boolean {
  return !item.allowedSlots?.length || (flag !== undefined && item.allowedSlots.includes(flag));
}

function combine(base: ResistVector, minus: ResistVector, plus: ResistVector): ResistVector {
  const out: ResistVector = {};
  for (const c of RESIST_COLUMNS) {
    const v = (base[c.key] ?? 0) - (minus[c.key] ?? 0) + (plus[c.key] ?? 0);
    if (v !== 0) out[c.key] = v;
  }
  return out;
}

/**
 * Where each cappable resistance has to end up: at cap, or — for one that was
 * already short before the swap — no worse than it was. A swap is not
 * charged with a shortfall it did not open.
 */
export function targets(before: ResistVector, caps: ResistVector): ResistVector {
  const out: ResistVector = {};
  for (const c of CAPPABLE) out[c.key] = Math.min(caps[c.key] ?? 0, Math.max(before[c.key] ?? 0, 0));
  return out;
}

/** The resistances the swap leaves short of their target — what `closable` has to close. */
export function openedGaps(input: Pick<ClosableInput, 'before' | 'after' | 'caps'>): OpenedGap[] {
  const goal = targets(input.before, input.caps);
  const out: OpenedGap[] = [];
  for (const c of CAPPABLE) {
    const after = input.after[c.key] ?? 0;
    const short = (goal[c.key] ?? 0) - after;
    if (short > 0) out.push({ key: c.key, label: c.label, short: Math.round(short * 10) / 10 });
  }
  return out;
}

function shortfall(v: ResistVector, goal: ResistVector): number {
  let total = 0;
  for (const c of CAPPABLE) total += Math.max(0, (goal[c.key] ?? 0) - (v[c.key] ?? 0));
  return total;
}

/** A move that leaves some resistance below its target *and* lower than it was is a regression. */
function regresses(from: ResistVector, to: ResistVector, goal: ResistVector): boolean {
  for (const c of CAPPABLE) {
    const t = to[c.key] ?? 0;
    if (t < (goal[c.key] ?? 0) && t < (from[c.key] ?? 0) - 1e-9) return true;
  }
  return false;
}

/** Whether an augment's lines touch any resistance still short. */
function touchesGap(lines: ResistVector, v: ResistVector, goal: ResistVector): boolean {
  for (const c of CAPPABLE) {
    if ((lines[c.key] ?? 0) > 0 && (v[c.key] ?? 0) < (goal[c.key] ?? 0)) return true;
  }
  return false;
}

/** An augment legal in one socket, with its resistance lines resolved once. */
interface SocketOption {
  augment: AugmentOption;
  lines: ResistVector;
}

/** The re-augmentation of `sockets` that brings `start` to `goal`, or undefined. */
function reaugment(
  start: ResistVector,
  goal: ResistVector,
  sockets: readonly ArmourSocket[],
  options: readonly (readonly SocketOption[])[],
  current: readonly ResistVector[],
  budget: { nodes: number },
): { chosen: (AugmentOption | undefined)[]; v: ResistVector } | undefined {

  // Greedy: the move that closes most, never one that opens or deepens a gap.
  let v = start;
  const chosen: (AugmentOption | undefined)[] = sockets.map(() => undefined);
  for (let step = 0; step < sockets.length && shortfall(v, goal) > 0; step++) {
    let best: { i: number; a: AugmentOption; next: ResistVector; gain: number } | undefined;
    for (let i = 0; i < sockets.length; i++) {
      if (chosen[i]) continue;
      for (const { augment: a, lines } of options[i]!) {
        const next = combine(v, current[i]!, lines);
        if (regresses(v, next, goal)) continue;
        const gain = shortfall(v, goal) - shortfall(next, goal);
        if (gain <= 0) continue;
        if (!best || gain > best.gain || (gain === best.gain && a.iron < best.a.iron)) best = { i, a, next, gain };
      }
    }
    if (!best) break;
    chosen[best.i] = best.a;
    v = best.next;
  }
  if (shortfall(v, goal) <= 0) return { chosen, v };

  // Greedy stalled: a bounded exhaustive pass over the sockets in order, each
  // either kept or given an augment that touches something still short. The
  // node budget belongs to the whole `findClosable` call, not to this pass —
  // a per-call budget times a dozen component options is a dozen times the
  // work, on a document that runs this a hundred times in the main process.
  const pick: (AugmentOption | undefined)[] = sockets.map(() => undefined);
  const dfs = (i: number, at: ResistVector): ResistVector | undefined => {
    if (shortfall(at, goal) <= 0) return at;
    if (i >= sockets.length || ++budget.nodes > NODE_CAP) return undefined;
    const kept = dfs(i + 1, at);
    if (kept) return kept;
    // Filter only: the options come pre-ordered by how much resistance they
    // carry, and re-sorting them at every node by their effect on *this* node's
    // vector cost more than the ordering was worth — a hundred `combine`s per
    // node, on a search whose whole job is to be bounded.
    for (const { augment: a, lines } of options[i]!) {
      if (!touchesGap(lines, at, goal)) continue;
      const next = combine(at, current[i]!, lines);
      if (regresses(at, next, goal)) continue;
      pick[i] = a;
      const done = dfs(i + 1, next);
      if (done) return done;
      pick[i] = undefined;
    }
    return undefined;
  };
  const done = dfs(0, start);
  return done ? { chosen: pick, v: done } : undefined;
}

/**
 * One assignment that closes every gap the swap opened, or undefined. The
 * component socket is tried first as carried, then with each free component
 * that fits, most helpful first — the carried component is preferred by
 * ordering, and displacing it is stated on the witness.
 */
export function findClosable(input: ClosableInput): ClosableWitness | undefined {
  const goal = targets(input.before, input.caps);
  if (shortfall(input.after, goal) <= 0) return undefined;

  // Resolved once for the whole call: every component option below re-runs the
  // same socket search, and `resistContributions` is not free.
  const lineCache = new Map<DbItem, ResistVector>();
  const linesOf = (item: DbItem | undefined): ResistVector => {
    if (!item) return {};
    let v = lineCache.get(item);
    if (!v) {
      v = resistOf(item);
      lineCache.set(item, v);
    }
    return v;
  };
  const magnitude = (v: ResistVector): number => CAPPABLE.reduce((n, c) => n + (v[c.key] ?? 0), 0);
  const socketOptions: SocketOption[][] = input.sockets.map((s) =>
    input.augments
      .filter((a) => fitsFlag(a.item, s.flag) && a.item.record !== s.augment?.record)
      .map((augment) => ({ augment, lines: linesOf(augment.item) }))
      // Ordered once, by how much resistance the augment carries: the DFS below
      // takes them in this order rather than re-ranking per node.
      .sort((x, y) => magnitude(y.lines) - magnitude(x.lines)),
  );
  const socketCurrent = input.sockets.map((s) => linesOf(s.augment));
  const budget = { nodes: 0 };

  const options: (ComponentOption | undefined)[] = [undefined];
  if (input.target) {
    const { flag, current } = input.target;
    const gapLines = (item: DbItem): number => {
      const lines = linesOf(item);
      let sum = 0;
      for (const c of CAPPABLE) {
        if ((input.after[c.key] ?? 0) < (goal[c.key] ?? 0)) sum += lines[c.key] ?? 0;
      }
      return sum;
    };
    options.push(
      ...input.components
        .filter((c) => fitsFlag(c.item, flag) && c.item.record !== current?.record && gapLines(c.item) > 0)
        .sort((x, y) => gapLines(y.item) - gapLines(x.item)),
    );
  }

  for (const option of options) {
    const start = option ? combine(input.after, linesOf(input.target?.current), linesOf(option.item)) : input.after;
    const found = reaugment(start, goal, input.sockets, socketOptions, socketCurrent, budget);
    if (!found) continue;
    const reaugments: Reaugment[] = [];
    let iron = 0;
    found.chosen.forEach((a, i) => {
      if (!a) return;
      const socket = input.sockets[i]!;
      reaugments.push({ slot: socket.slot, augment: a, ...(socket.augment ? { replaces: socket.augment } : {}) });
      iron += a.iron;
    });
    const fill: ComponentFill | undefined = option
      ? { component: option, ...(input.target?.current ? { displaces: input.target.current } : {}) }
      : undefined;
    return { reaugments, ...(fill ? { fill } : {}), iron, predicted: found.v };
  }
  return undefined;
}
