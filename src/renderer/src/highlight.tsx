/**
 * "Where is that item?"
 *
 * The loadout on the left proposes an item that is sitting somewhere in a bag,
 * a stash tab or the transfer stash — and finding it by hand across four
 * containers and a dozen tabs is the tedious half of acting on advice. Hovering
 * the proposal lights the item up wherever it lives; clicking flips the
 * container panel to the tab holding it.
 *
 * The highlight is a *set* of ids, not one: a verdict row is about two items —
 * what comes off and what goes on — and lighting only one of them makes the
 * reader do the join the window exists to do for them.
 *
 * There are two marks, not one. The highlight follows the pointer; the
 * *actionable* set stands still, and holds every item the plan asks you to do
 * something with. Without it, finding the six items that matter in a stash of
 * two hundred means hovering the advice table row by row.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import type { AdviceMark } from '../../shared/advice-marks.js';
import type { ItemPosition } from '../../shared/ipc.js';
import type { ActionKind } from './advice.js';

export interface RevealRequest {
  docId: string;
  position: ItemPosition;
  /** Bumped on every request so a repeat click on the same item still acts. */
  nonce: number;
}

interface HighlightApi {
  /** True for an item currently being pointed at, directly or by a verdict row. */
  isHighlighted: (docId: string) => boolean;
  /** Whether anything at all is highlighted — for the "no dots" case. */
  any: boolean;
  /** Pass one id, several, or nothing to clear. */
  highlight: (docIds: string | readonly string[] | null) => void;
  /**
   * A second, *held* set, unioned with the pointer's.
   *
   * The tooltip owns this one. A reader who moves onto the panel to finish
   * reading it has not stopped being interested in the item — but they have
   * stopped pointing at it, so the pointer set empties and the card and its
   * container copy both went dark under them. Held separately rather than by
   * making the pointer set sticky, because everything else that highlights (a
   * verdict row naming two items, a key move naming four) really is transient.
   */
  holdHighlight: (docIds: string | readonly string[] | null) => void;
  /**
   * The kind of action the container legend is pointing at, if any.
   *
   * Exposed as a *kind* rather than folded into the id sets on purpose: this
   * highlight belongs to the containers alone. The legend counts what is in the
   * containers ("sell or salvage 13"), so lighting the loadout's proposed card
   * for one of those items would answer a question the reader did not ask — and
   * an id-based highlight cannot tell the two places apart, because a candidate
   * in a stash and the proposal that names it are the same item. Only `ItemCell`
   * and the material list read this, which is what scopes it.
   */
  litKind: ActionKind | null;
  highlightKind: (kind: ActionKind | null) => void;
  /** What the current plan asks you to do with this item, if anything. */
  actionFor: (docId: string) => ActionKind | undefined;
  /** Everything the plan says about this item — the badge and the action tooltip. */
  adviceFor: (docId: string) => readonly AdviceMark[];
  /** Replace the whole action map; called once per advice run. */
  setActions: (actions: Readonly<Record<string, ActionKind>>) => void;
  /** Replace the whole mark map; called from the same place, with the same plan. */
  setAdvice: (marks: ReadonlyMap<string, AdviceMark[]>) => void;
  reveal: RevealRequest | null;
  requestReveal: (docId: string, position: ItemPosition) => void;
}

const HighlightContext = createContext<HighlightApi | undefined>(undefined);

export function useHighlight(): HighlightApi {
  const api = useContext(HighlightContext);
  if (!api) throw new Error('useHighlight outside a HighlightProvider');
  return api;
}

export function HighlightProvider({ children }: { children: ReactNode }): ReactNode {
  const [highlighted, setHighlighted] = useState<readonly string[]>(EMPTY);
  const [held, setHeld] = useState<readonly string[]>(EMPTY);
  const [actions, setActionsState] = useState<Readonly<Record<string, ActionKind>>>(NO_ACTIONS);
  const [advice, setAdviceState] = useState<ReadonlyMap<string, AdviceMark[]>>(NO_ADVICE);
  const [litKind, setLitKind] = useState<ActionKind | null>(null);
  const [reveal, setReveal] = useState<RevealRequest | null>(null);

  const highlight = useCallback((docIds: string | readonly string[] | null) => {
    setHighlighted(asIds(docIds));
  }, []);
  const holdHighlight = useCallback((docIds: string | readonly string[] | null) => {
    // Same ids again must not re-render every cell in the window: the tooltip
    // re-asserts its subject on every boundary the pointer crosses inside a card.
    setHeld((prev) => {
      const next = asIds(docIds);
      return next.length === prev.length && next.every((id, i) => prev[i] === id) ? prev : next;
    });
  }, []);
  const setActions = useCallback((next: Readonly<Record<string, ActionKind>>) => {
    setActionsState((prev) => (sameActions(prev, next) ? prev : next));
  }, []);
  // Both maps are derived from the same envelope in one `useMemo`, so identity
  // is enough here — no deep comparison, and setting the same run's marks again
  // does not re-render a grid of two hundred cells.
  const setAdvice = useCallback((next: ReadonlyMap<string, AdviceMark[]>) => {
    setAdviceState((prev) => (prev === next ? prev : next));
  }, []);
  const highlightKind = useCallback((kind: ActionKind | null) => {
    setLitKind((prev) => (prev === kind ? prev : kind));
  }, []);
  const requestReveal = useCallback((docId: string, position: ItemPosition) => {
    setReveal((prev) => ({ docId, position, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  const api = useMemo(
    () => ({
      isHighlighted: (docId: string) => highlighted.includes(docId) || held.includes(docId),
      any: highlighted.length > 0 || held.length > 0,
      highlight,
      holdHighlight,
      litKind,
      highlightKind,
      actionFor: (docId: string) => actions[docId],
      adviceFor: (docId: string) => advice.get(docId) ?? NO_MARKS,
      setActions,
      setAdvice,
      reveal,
      requestReveal,
    }),
    [
      highlighted,
      held,
      highlight,
      holdHighlight,
      litKind,
      highlightKind,
      actions,
      setActions,
      advice,
      setAdvice,
      reveal,
      requestReveal,
    ],
  );
  return <HighlightContext.Provider value={api}>{children}</HighlightContext.Provider>;
}

/** One shared empty array, so clearing twice does not re-render. */
const EMPTY: readonly string[] = [];

/** One id, several, or nothing — normalized, with the empty case shared. */
function asIds(docIds: string | readonly string[] | null): readonly string[] {
  if (docIds === null) return EMPTY;
  if (typeof docIds === 'string') return docIds ? [docIds] : EMPTY;
  const kept = docIds.filter(Boolean);
  return kept.length === 0 ? EMPTY : kept;
}
const NO_ACTIONS: Readonly<Record<string, ActionKind>> = {};
const NO_ADVICE: ReadonlyMap<string, AdviceMark[]> = new Map();
/** One shared empty list, so an unmarked cell's `adviceFor` is referentially stable. */
const NO_MARKS: readonly AdviceMark[] = [];

/**
 * The marks, for a component that may be rendered outside a provider.
 *
 * The tooltip layer is the caller: it needs to know whether the item under the
 * pointer is one the plan touches, and it is mounted in stories that have no
 * `HighlightProvider` at all. Returning nothing there is the right answer — no
 * provider means no advice — where `useHighlight`'s throw would be a crash.
 */
export function useAdviceMarks(docId: string | undefined): readonly AdviceMark[] {
  const api = useContext(HighlightContext);
  return docId && api ? api.adviceFor(docId) : NO_MARKS;
}

/**
 * The held set's setter, for the tooltip — which is mounted inside this provider
 * in the app but also on its own in the isolated stories, where holding nothing
 * is the right answer rather than a crash.
 */
export function useHoldHighlight(): HighlightApi['holdHighlight'] {
  return useContext(HighlightContext)?.holdHighlight ?? noop;
}

function noop(): void {}

/** Setting the same marks again must not re-render every grid cell in the window. */
function sameActions(
  prev: Readonly<Record<string, ActionKind>>,
  next: Readonly<Record<string, ActionKind>>,
): boolean {
  const keys = Object.keys(next);
  return keys.length === Object.keys(prev).length && keys.every((id) => prev[id] === next[id]);
}
