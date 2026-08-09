/**
 * What the plan says about one particular item, keyed by the item.
 *
 * The plan is organised by *slot*; a reader looking at a stash is organised by
 * *item*. This is the inversion, and it is the difference between "the advice
 * mentions six things somewhere" and "this is one of them, and here is what it
 * says". Everything painted on an item cell — the badge, its colour, the action
 * tooltip — comes from here.
 *
 * Three rules earn their own note:
 *
 * - **`KEEP` gets no mark.** It is the state the character is already in. A mark
 *   on every kept item would put a mark on almost every slot, which makes the
 *   marks that mean "do something" invisible.
 * - **An `EQUIP` marks both sides.** The worn item and the candidate: one says
 *   "this comes off", the other "go and fetch this", and the second is the one
 *   that saves a hunt through four containers and a dozen tabs.
 * - **A socketable target has no position.** Components and augments carry
 *   dossier ids but live in a store, not on a grid — so the mark on a socket
 *   verdict lands on the host item, which is the thing the reader can point at.
 *   The socketable's own identity is in `targetId`; the loadout renders it.
 *
 * Pure and shared rather than a renderer helper because `Verdict` is the plan's
 * own vocabulary and this is a statement about the plan, not about the window.
 * Nothing here may import a Node builtin.
 */

import type { AdvisorPlan } from '../core/ai/provider.js';

/** Every verdict value, as the plan writes it. Kept as a string so an unknown one still renders. */
export type MarkVerdict = AdvisorPlan['verdicts'][number]['verdict'];

export interface AdviceMark {
  /**
   * Which array of the plan this came from. `hold` and `sell` are **not**
   * verdicts — a hold has no slot and a sell has neither slot nor reason field —
   * so they cannot be folded into the enum without inventing values.
   */
  kind: 'verdict' | 'hold' | 'sell';
  /** Absent for `hold`/`sell`, which is exactly why `kind` exists. */
  verdict?: MarkVerdict;
  /** True on the incoming half of a move — the candidate rather than the worn item. */
  incoming?: boolean;
  /**
   * True when the mark is on an item this move **destroys** — the host an
   * extraction is spent on. Stated as a field rather than inferred from the
   * reason string because it decides the mark's colour, and red is not a thing
   * to get from a regex.
   */
  destroys?: boolean;
  /**
   * What the move brings in: another item for an `EQUIP`, a socketable for the
   * four socket verdicts. Carried even on the host's mark, because "swap the
   * component → Seal of Blades" is one sentence and the name is half of it.
   */
  targetId?: string;
  targetName?: string;
  /** The slot the move is about; for a hold, the slot it is being held *for*. */
  slot?: string;
  /**
   * Socketables to fit into the item this move leaves in the slot.
   *
   * Carried on the mark because the candidate's own badge is where a reader
   * standing in front of a stash will look: "fetch this" and "fetch this and put
   * a Dread Skull in it" are different errands, and the second one is only
   * findable here — the loadout's proposal card shows the finished item, but the
   * container cell is what you are pointing at when you go to get it.
   */
  fits?: readonly { kind: 'component' | 'augment'; id: string; name?: string }[];
  gains: string[];
  costs: string[];
  reason: string;
  /** The threshold that ends a hold — `level 84`, `42 more spirit`. */
  until?: string;
  /** Titles of key moves that name this item, so a mark can say it is part of one. */
  keyMoves: string[];
}

/**
 * Every id the plan has something to say about, to what it says.
 *
 * A list per id rather than one mark: an item can be the host of a socket move
 * *and* the extraction source for another slot's component, and collapsing that
 * to one mark would drop the half that costs the item its life.
 */
export function adviceMarks(plan: AdvisorPlan | null | undefined): Map<string, AdviceMark[]> {
  const out = new Map<string, AdviceMark[]>();
  if (!plan) return out;

  const add = (id: string | undefined, mark: AdviceMark): void => {
    if (!id) return;
    const list = out.get(id);
    if (list) list.push(mark);
    else out.set(id, [mark]);
  };

  // Key move titles first, so every mark below can name the ones it belongs to.
  const movesFor = new Map<string, string[]>();
  for (const move of plan.keyMoves ?? []) {
    for (const id of move.itemIds) {
      const titles = movesFor.get(id);
      if (titles) titles.push(move.title);
      else movesFor.set(id, [move.title]);
    }
  }
  const keyMoves = (id: string | undefined): string[] => (id ? (movesFor.get(id) ?? []) : []);

  for (const v of plan.verdicts) {
    // The default state, not an action. See the note above.
    if (v.verdict === 'KEEP') continue;

    // An `EQUIP`'s target *is* an item id — the schema says so, and
    // `normalizePlan` strips the `#` off it for exactly that reason — so either
    // field may carry it and whichever is filled is the candidate. For the four
    // socket verdicts `target` is a socketable's name and only `targetId` is an
    // id, which is why the two cases cannot share one lookup.
    const targetId = v.verdict === 'EQUIP' ? (v.targetId ?? v.target) : v.targetId;
    const common = {
      kind: 'verdict' as const,
      verdict: v.verdict,
      slot: v.slot,
      gains: [...(v.gains ?? [])],
      costs: [...(v.costs ?? [])],
      reason: v.reason,
      ...(targetId ? { targetId } : {}),
      ...(v.targetName ?? v.target ? { targetName: v.targetName ?? v.target! } : {}),
      ...(v.fits?.length ? { fits: v.fits } : {}),
    };

    add(v.itemId, { ...common, keyMoves: keyMoves(v.itemId) });

    // The incoming half. Only an `EQUIP`'s target is an *item* id that a grid can
    // hold: the socket verdicts' targets are socketables, which live in the
    // reagent store and have no cell of their own. Marking one would put a badge
    // on nothing.
    if (v.verdict === 'EQUIP' && targetId && targetId !== v.itemId) {
      add(targetId, { ...common, incoming: true, keyMoves: keyMoves(targetId) });
    }

    // The item an extraction spends. It is not the subject of this verdict at
    // all — it is somewhere else entirely, and it is about to be destroyed,
    // which is the one consequence a reader must not have to go looking for.
    if (v.componentFrom) {
      add(v.componentFrom, {
        kind: 'verdict',
        verdict: v.verdict,
        destroys: true,
        slot: v.slot,
        gains: [],
        costs: [],
        reason: `Destroyed by extracting ${common.targetName ?? 'its component'}.`,
        ...(targetId ? { targetId } : {}),
        ...(common.targetName ? { targetName: common.targetName } : {}),
        keyMoves: keyMoves(v.componentFrom),
      });
    }
  }

  for (const h of plan.hold) {
    add(h.itemId, {
      kind: 'hold',
      gains: [...(h.gains ?? [])],
      costs: [],
      reason: h.reason,
      ...(h.slot ? { slot: h.slot } : {}),
      ...(h.until ? { until: h.until } : {}),
      ...(h.beats ? { targetId: h.beats } : {}),
      keyMoves: keyMoves(h.itemId),
    });
  }

  // Bare ids: the schema gives a sell no reason and no slot, because there is
  // nothing to say beyond "this is not for this build".
  for (const id of plan.sell) {
    add(id, { kind: 'sell', gains: [], costs: [], reason: '', keyMoves: keyMoves(id) });
  }

  return out;
}

/**
 * The ids the plan names that the live snapshot has never heard of.
 *
 * Document ids are only reproducible from identical save + database state, so a
 * save the game has rewritten since the run produces ids that simply fail to
 * join. Those are listed by name rather than dropped: an item quietly missing
 * from the advice is indistinguishable from advice that never mentioned it.
 */
export function staleIds(marks: Map<string, AdviceMark[]>, known: (id: string) => boolean): string[] {
  return [...marks.keys()].filter((id) => !known(id));
}
