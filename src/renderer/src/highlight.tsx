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
  /** What the current plan asks you to do with this item, if anything. */
  actionFor: (docId: string) => ActionKind | undefined;
  /** Replace the whole action map; called once per advice run. */
  setActions: (actions: Readonly<Record<string, ActionKind>>) => void;
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
  const [actions, setActionsState] = useState<Readonly<Record<string, ActionKind>>>(NO_ACTIONS);
  const [reveal, setReveal] = useState<RevealRequest | null>(null);

  const highlight = useCallback((docIds: string | readonly string[] | null) => {
    if (docIds === null) setHighlighted(EMPTY);
    else if (typeof docIds === 'string') setHighlighted([docIds]);
    else setHighlighted(docIds.filter(Boolean));
  }, []);
  const setActions = useCallback((next: Readonly<Record<string, ActionKind>>) => {
    setActionsState((prev) => (sameActions(prev, next) ? prev : next));
  }, []);
  const requestReveal = useCallback((docId: string, position: ItemPosition) => {
    setReveal((prev) => ({ docId, position, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  const api = useMemo(
    () => ({
      isHighlighted: (docId: string) => highlighted.includes(docId),
      any: highlighted.length > 0,
      highlight,
      actionFor: (docId: string) => actions[docId],
      setActions,
      reveal,
      requestReveal,
    }),
    [highlighted, highlight, actions, setActions, reveal, requestReveal],
  );
  return <HighlightContext.Provider value={api}>{children}</HighlightContext.Provider>;
}

/** One shared empty array, so clearing twice does not re-render. */
const EMPTY: readonly string[] = [];
const NO_ACTIONS: Readonly<Record<string, ActionKind>> = {};

/** Setting the same marks again must not re-render every grid cell in the window. */
function sameActions(
  prev: Readonly<Record<string, ActionKind>>,
  next: Readonly<Record<string, ActionKind>>,
): boolean {
  const keys = Object.keys(next);
  return keys.length === Object.keys(prev).length && keys.every((id) => prev[id] === next[id]);
}
