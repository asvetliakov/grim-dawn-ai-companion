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

import { adviceMarks } from '../../shared/advice-marks.js';
import type { AdviseEnvelope, AdvisorPlan, VerdictRow } from '../../shared/ipc.js';
import { slotKey, verdictSlotKey } from '../../shared/slots.js';

export { slotKey } from '../../shared/slots.js';

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
 * The socketables this slot is told to fit beyond the one its verdict is named
 * for — see `socketFitSchema` in the provider.
 *
 * These are what makes an `EQUIP` proposal complete. "Wear Maiven's Lens" and
 * "wear Maiven's Lens with a Dread Skull in it and a Sagethorn Powder on it" are
 * different items with different stats, and the second is the one the advisor
 * actually argued for.
 */
export function socketFits(advice: SlotAdvice | undefined): readonly SocketFit[] {
  return advice?.plan?.fits ?? [];
}

export type SocketFit = NonNullable<PlanVerdict['fits']>[number];

/**
 * The rendered rows carry everything but the verdict *word* — `verdictRows`
 * turns it into `replaces` and an action string — so the label comes back off
 * the plan itself. Worth the second lookup: "HOLD" and "SELL" are different
 * advice about the same non-replacement, and a row that showed both as blank
 * would be actively misleading.
 */
export function adviceBySlot(envelope: AdviseEnvelope | null, activeSet: 1 | 2 = 1): Map<string, SlotAdvice> {
  const verdicts = new Map<string, PlanVerdict>();
  // The plan's slot strings are model text, so they go through the alias-aware
  // key — `Main hand` joins the active set's main-hand row instead of nothing.
  for (const v of envelope?.plan?.verdicts ?? []) verdicts.set(verdictSlotKey(v.slot, activeSet), v);

  const out = new Map<string, SlotAdvice>();
  for (const row of envelope?.verdictRows ?? []) {
    const key = verdictSlotKey(row.slot, activeSet);
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
 * What the plan asks you to do with an item — four different things, so four
 * different marks.
 *
 * `equip` is "put this on now". `hold` is "keep this, you will put it on later"
 * — a different action with a different urgency, and lumping the two together
 * makes a stash of held items look like a stash of upgrades. `destroy` and
 * `sell` are both "this item goes away", and they are still not the same
 * instruction: an Inventor extraction spends the host to recover what is in it,
 * where a sell is a judgement that the item is not for this build.
 */
export type ActionKind = 'equip' | 'hold' | 'destroy' | 'sell';

/** Irreversible first, then what to do now, then what to do later. */
const ACTION_RANK: Record<ActionKind, number> = { destroy: 0, equip: 1, sell: 2, hold: 3 };

/**
 * Every id the plan asks the player to act on, and what the action is.
 *
 * The hover highlight answers "where is the one I am pointing at"; this answers
 * the question that comes first — "which of these two hundred items does the
 * advice touch at all". So it is a standing mark rather than a hover.
 *
 * Derived from `adviceMarks` rather than read off the envelope a second time:
 * the badge, the colour and the action tooltip all describe the same judgement,
 * and two readings of one plan is one reading too many.
 *
 * What is already worn is deliberately absent: it is on the character, not in a
 * container, so the *outgoing* half of a move gets no flag here — the loadout's
 * own verdict column says it, in the place the reader is already looking. So are
 * `keyMoves` item ids: a key move *argues* about items its verdicts already
 * name, and a mark meaning "mentioned somewhere" is not an action.
 */
export function actionMarks(envelope: AdviseEnvelope | null): Record<string, ActionKind> {
  const out: Record<string, ActionKind> = {};
  const mark = (id: string, kind: ActionKind): void => {
    if (!id) return;
    const existing = out[id];
    if (existing === undefined || ACTION_RANK[kind] < ACTION_RANK[existing]) out[id] = kind;
  };
  for (const [id, marks] of adviceMarks(envelope?.plan)) {
    for (const m of marks) {
      if (m.destroys) mark(id, 'destroy');
      else if (m.kind === 'sell') mark(id, 'sell');
      else if (m.kind === 'hold') mark(id, 'hold');
      else if (m.incoming) mark(id, 'equip');
    }
  }
  return out;
}

/** What a slot is holding, and carrying, right now. */
export interface WornSlot {
  itemId: string;
  /** Display name, so an item that was only re-socketed can be recognised. */
  display: string;
  componentId?: string;
  augmentId?: string;
}

/** One slot whose contents no longer match what the run was written against. */
export interface SlotDrift {
  slot: string;
  /** What was in it when the run started; empty if the slot was empty. */
  wasId: string;
  /** What is in it now; empty if the slot is now empty. */
  nowId: string;
  /**
   * True when what is in it now is exactly what the plan told this slot to end up
   * with — the advice was **carried out**, not overtaken.
   */
  applied: boolean;
  /**
   * Whether the *item* changed or only what it carries.
   *
   * These need telling apart because an item's document id **includes its
   * attachments** — `itemId` hashes the component's and augment's names and seeds
   * along with the base — so socketing a component changes the id of an item that
   * is otherwise untouched. Reported as an item change, that reads "Feet now holds
   * Bloodhound Greaves (was Bloodhound Greaves)".
   */
  changed: 'item' | 'sockets';
  /** For a socket change, what is in the sockets now — by name where known. */
  socketNames: string[];
}

/**
 * Where the live loadout has moved away from the one the run was written for.
 *
 * The whole reason this is per-slot and not a single "is it stale" bit: **acting
 * on the advice is what makes the loadout differ from it.** A run that says
 * "equip Maiven's Lens" describes a save without Maiven's Lens equipped, so the
 * instant the user does what it says, a naive fingerprint check calls the answer
 * stale and — in the design that suggests itself first — throws away a twelve-
 * minute, four-dollar answer as its reward for being followed. Splitting the two
 * cases costs one comparison against the plan's own `nextId`, and turns the
 * check from a nuisance into the most useful line in the panel: *this move is
 * done*.
 *
 * A run stored before `worn` existed reports nothing rather than guessing.
 */
export function loadoutDrift(
  envelope: AdviseEnvelope | null,
  worn: Record<string, WornSlot>,
  activeSet: 1 | 2 = 1,
): SlotDrift[] {
  const before = envelope?.worn;
  if (!before) return [];
  const socketsBefore = envelope.wornSockets ?? {};

  // The item each slot was told to end up holding, by the same slot key the
  // verdict table joins on — alias-aware on the verdict side, because the slot
  // strings are model text. Only a replacement changes the item, so everything
  // else expects to find what it started with.
  const equipTo = new Map<string, string>();
  for (const row of envelope.verdictRows) {
    if (row.replaces && row.nextId) equipTo.set(verdictSlotKey(row.slot, activeSet), row.nextId);
  }

  // Every socketable the plan asked a slot to end up carrying: the one its verdict
  // is named for, plus anything in `fits`. Socketables are identified by record
  // path, so an installed copy and a proposed one share an id — which is what
  // makes "is it in there yet" answerable at all.
  const socketTo = new Map<string, Set<string>>();
  for (const v of envelope.plan?.verdicts ?? []) {
    const wanted = new Set<string>();
    if (SOCKET_VERDICTS.has(v.verdict) && v.targetId) wanted.add(v.targetId);
    for (const fit of v.fits ?? []) wanted.add(fit.id);
    if (wanted.size > 0) socketTo.set(verdictSlotKey(v.slot, activeSet), wanted);
  }

  const slots = new Set([...Object.keys(before), ...Object.keys(worn)]);
  const out: SlotDrift[] = [];
  for (const slot of slots) {
    const wasId = before[slot] ?? '';
    const now = worn[slot];
    const nowId = now?.itemId ?? '';
    if (wasId === nowId) continue;

    const key = slotKey(slot);
    const wasSockets = socketsBefore[slot] ?? {};
    const nowSockets = [now?.componentId, now?.augmentId].filter((id): id is string => id !== undefined);
    const socketsMoved =
      (wasSockets.component ?? '') !== (now?.componentId ?? '') ||
      (wasSockets.augment ?? '') !== (now?.augmentId ?? '');

    // Same name, same slot, different id, and its sockets moved: the item was
    // re-socketed rather than replaced. The name comparison is what rules out the
    // coincidence of a *different* item arriving with different sockets — and the
    // stored name is available because the envelope carries `itemNames`.
    const sameItem =
      socketsMoved && now !== undefined && wasId !== '' && envelope.itemNames[wasId] === now.display;

    const wanted = socketTo.get(key);
    const socketApplied = wanted !== undefined && nowSockets.some((id) => wanted.has(id));
    const equipApplied = nowId !== '' && equipTo.get(key) === nowId;

    out.push({
      slot,
      wasId,
      nowId,
      applied: equipApplied || (sameItem && socketApplied) || (socketApplied && !equipTo.has(key)),
      changed: sameItem ? 'sockets' : 'item',
      socketNames: nowSockets,
    });
  }
  return out;
}

/**
 * The projected resistance for a column label.
 *
 * The tool-computed projection wins when the envelope carries one — it is the
 * plan applied to the actual save and re-aggregated, where the model's own
 * `projectedResistances` is arithmetic it did in its head. The model's figures
 * remain the fallback for runs stored before the projection existed.
 *
 * Keyed by the §3 column labels (`Fire`, `Aether`, …) because that is what the
 * document showed the model; the lookup is case-insensitive for the same
 * reason the slot join is.
 */
export function projectedResistances(envelope: AdviseEnvelope | null): Map<string, number> {
  const out = new Map<string, number>();
  const computed = envelope?.projection?.resistances;
  if (computed?.length) {
    for (const row of computed) out.set(row.label.toLowerCase(), row.after);
    return out;
  }
  for (const [label, value] of Object.entries(envelope?.plan?.projectedResistances ?? {})) {
    out.set(label.toLowerCase(), value);
  }
  return out;
}
