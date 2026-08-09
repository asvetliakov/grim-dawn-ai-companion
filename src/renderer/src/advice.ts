/**
 * Reading an advice envelope from the loadout's point of view.
 *
 * The envelope is per-verdict; the loadout is per-slot. This is the join, and
 * it is deliberately forgiving about the slot string: the model writes the
 * slot heading back out of the dossier, so it is usually exact but is still
 * free text. Matching on a normalized form means "Ring 1", "ring1" and
 * "Weapon set 1 main" all land where they belong instead of silently
 * disappearing from the table.
 */

import type { AdviseEnvelope, AdvisorPlan, VerdictRow } from '../../shared/ipc.js';

/** One entry of the plan's own verdict array, before it became a table row. */
export type PlanVerdict = AdvisorPlan['verdicts'][number];

/**
 * Verdicts whose target is a component or an augment rather than an item.
 *
 * Mirrors `SOCKET_VERDICTS` in the provider. It is duplicated rather than
 * imported because that module reaches the zod schema and the renderer compiles
 * with `types: []`; the list is four literals and the plan schema is what would
 * fail loudly if it grew a fifth.
 */
const SOCKET_VERDICTS = new Set(['RE-AUGMENT', 'ADD-COMPONENT', 'SWAP-COMPONENT', 'BUY-AUGMENT']);

/** `Weapon set 1 main` → `weaponset1main`. */
export function slotKey(slot: string): string {
  return slot.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface SlotAdvice {
  row: VerdictRow;
  /** `EQUIP`, `KEEP`, `HOLD`, … — the plan's own word for the move. */
  verdict: string;
  /** The plan's own entry, which carries what the flattened row drops. */
  plan?: PlanVerdict;
  /** True when the verdict actually replaces the item in the slot. */
  replaces: boolean;
  /** Display name of the proposed item, when there is one. */
  targetName: string;
  targetId: string;
}

/**
 * The socketable this verdict proposes, if it proposes one.
 *
 * A socket move keeps the item and changes what it carries, so the id lives in
 * the plan's `targetId` and never in the row's `nextId` — which is reserved for
 * the one verdict that swaps the item itself. `from` is the host an extraction
 * would **destroy**, which is the part of the move a reader most needs told.
 */
export function socketMove(advice: SlotAdvice | undefined): SocketMove | undefined {
  const v = advice?.plan;
  if (!v || !SOCKET_VERDICTS.has(v.verdict)) return undefined;
  return {
    id: v.targetId ?? '',
    name: v.targetName ?? v.target ?? '',
    verdict: v.verdict,
    // `RE-AUGMENT` and `BUY-AUGMENT` are the augment socket; the two COMPONENT
    // verdicts are the other one. An item holds at most one of each, in
    // independent sockets, so the verdict alone says which one changes.
    kind: v.verdict.includes('AUGMENT') ? 'augment' : 'component',
    ...(v.componentFrom ? { from: v.componentFrom } : {}),
  };
}

/**
 * The verdict, short enough to sit in a column beside two item cards.
 *
 * `SWAP-COMPONENT` spelled out needs 120 px, which is width taken from the two
 * things the row exists to compare. The short forms keep the one distinction
 * that matters within each pair: `+` fills an **empty** socket and costs
 * nothing, `↔` replaces what is in one — and replacing destroys the old
 * component, or throws the old augment away. That is the difference between a
 * free upgrade and a decision, so it is the part that survives shortening.
 *
 * The full word is not lost: it is on the tag's `title`, and the advice table
 * below the loadout prints it in full in its Action column.
 */
const SHORT_VERDICT: Readonly<Record<string, string>> = {
  'ADD-COMPONENT': '+COMP',
  'SWAP-COMPONENT': '↔COMP',
  'BUY-AUGMENT': '+AUG',
  'RE-AUGMENT': '↔AUG',
};

/** `SWAP-COMPONENT` → `↔COMP`; anything already short is returned unchanged. */
export function shortVerdict(verdict: string): string {
  return SHORT_VERDICT[verdict] ?? verdict;
}

export interface SocketMove {
  id: string;
  name: string;
  verdict: string;
  kind: 'component' | 'augment';
  /** The host an extraction would destroy to get this socketable out. */
  from?: string;
}

/**
 * The rendered rows carry everything but the verdict *word* — `verdictRows`
 * turns it into `replaces` and an action string — so the label comes back off
 * the plan itself. Worth the second lookup: "HOLD" and "SELL" are different
 * advice about the same non-replacement, and a row that showed both as blank
 * would be actively misleading.
 */
export function adviceBySlot(envelope: AdviseEnvelope | null): Map<string, SlotAdvice> {
  const verdicts = new Map<string, PlanVerdict>();
  for (const v of envelope?.plan?.verdicts ?? []) verdicts.set(slotKey(v.slot), v);

  const out = new Map<string, SlotAdvice>();
  for (const row of envelope?.verdictRows ?? []) {
    const key = slotKey(row.slot);
    const plan = verdicts.get(key);
    out.set(key, {
      row,
      verdict: plan?.verdict ?? '',
      ...(plan ? { plan } : {}),
      replaces: row.replaces,
      targetName: row.nextName,
      targetId: row.nextId,
    });
  }
  return out;
}

export interface HeldItem {
  itemId: string;
  reason: string;
  until: string;
  /** The slot the hold is for, and the item it would displace there. */
  slot: string;
  beats: string;
  gains: string[];
}

/**
 * Items the plan says to keep hold of rather than equip or sell, by item id.
 *
 * These are **not** per-slot: a hold is a statement about an item you own and a
 * threshold that ends the wait ("level 84", "42 more spirit"), and the plan
 * schema keys it by item id precisely because the slot it will eventually go in
 * may already have a verdict of its own. Rendering them as a list, beside the
 * per-slot table rather than inside it, is the only presentation the data
 * actually supports.
 */
export function holds(envelope: AdviseEnvelope | null): HeldItem[] {
  return (envelope?.plan?.hold ?? []).map((h) => ({
    itemId: h.itemId,
    reason: h.reason,
    until: h.until ?? '',
    slot: h.slot ?? '',
    beats: h.beats ?? '',
    gains: h.gains ?? [],
  }));
}

/**
 * What the plan asks you to do with an item — three different things, so three
 * different marks.
 *
 * `equip` is "put this on now". `hold` is "keep this, you will put it on later"
 * — a different action with a different urgency, and lumping the two together
 * makes a stash of held items look like a stash of upgrades. `destroy` is the
 * one that cannot be undone: an Inventor extraction recovers the component *or*
 * the item, so the host is spent.
 */
export type ActionKind = 'equip' | 'hold' | 'destroy';

/** Irreversible first, then what to do now, then what to do later. */
const ACTION_RANK: Record<ActionKind, number> = { destroy: 0, equip: 1, hold: 2 };

/**
 * Every id the plan asks the player to act on, and what the action is.
 *
 * The hover highlight answers "where is the one I am pointing at"; this answers
 * the question that comes first — "which of these two hundred items does the
 * advice touch at all". So it is a standing mark rather than a hover.
 *
 * What is already worn is deliberately absent: it is on the character, not in a
 * container, and marking it would light up half the grid. So are `keyMoves`
 * item ids — a key move *argues* about items its verdicts already name, and a
 * mark meaning "mentioned somewhere" is not an action.
 */
export function actionMarks(envelope: AdviseEnvelope | null): Record<string, ActionKind> {
  const out: Record<string, ActionKind> = {};
  const mark = (id: string, kind: ActionKind): void => {
    if (!id) return;
    const existing = out[id];
    if (existing === undefined || ACTION_RANK[kind] < ACTION_RANK[existing]) out[id] = kind;
  };
  if (!envelope) return out;
  for (const row of envelope.verdictRows) mark(row.nextId, 'equip');
  for (const h of envelope.plan?.hold ?? []) mark(h.itemId, 'hold');
  for (const v of envelope.plan?.verdicts ?? []) if (v.componentFrom) mark(v.componentFrom, 'destroy');
  return out;
}

/**
 * The projected resistance for a column label, if the plan gave one.
 *
 * Keyed by the §3 column labels (`Fire`, `Aether`, …) because that is what the
 * document showed the model; the lookup is case-insensitive for the same
 * reason the slot join is.
 */
export function projectedResistances(envelope: AdviseEnvelope | null): Map<string, number> {
  const out = new Map<string, number>();
  for (const [label, value] of Object.entries(envelope?.plan?.projectedResistances ?? {})) {
    out.set(label.toLowerCase(), value);
  }
  return out;
}
