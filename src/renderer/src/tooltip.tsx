/**
 * One floating tooltip for the whole window.
 *
 * A character can reach a couple of hundred items, and giving each its own
 * floating instance would mean a couple of hundred auto-update loops. Instead
 * the hovered element becomes the position reference of a single instance —
 * which is also why flip/shift can be trusted to keep the panel on screen at
 * the edges, where plain CSS positioning gets it wrong.
 *
 * The subject is either an item or a lone socketable, because a component
 * hovered in the loadout deserves its own stats rather than the host item's.
 */

import { autoUpdate, flip, FloatingPortal, offset, shift, useFloating } from '@floating-ui/react';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import type { UiItem, UiSocketable } from '../../shared/ipc.js';
import { Tooltip, type TooltipSubject } from './components/ItemTooltip.js';

interface TooltipApi {
  show: (element: Element, item: UiItem) => void;
  showSocketable: (element: Element, label: string, part: UiSocketable, note?: string) => void;
  hide: () => void;
}

/**
 * What the panel positions itself against: the **card**, not whichever part of
 * it the pointer happens to be on.
 *
 * Making the whole card a hover target meant the raw event target could be an
 * icon, a name or a component chip, and anchoring to those made the panel jump
 * around inside one item. Anchoring to the card holds it still while the
 * pointer moves over the thing it describes.
 *
 * Anchoring to the *row* was tried and is worse: it is stable, but it puts the
 * panel past the proposal column even when the pointer is on the worn item on
 * the far left, which is a long way from what is being described. The card is
 * the thing; the panel belongs next to the thing.
 */
function anchorFor(element: Element): Element {
  return element.closest('.item-face, .item-cell, .material-row') ?? element;
}

const TooltipContext = createContext<TooltipApi | undefined>(undefined);

export function useTooltip(): TooltipApi {
  const api = useContext(TooltipContext);
  if (!api) throw new Error('useTooltip outside a TooltipProvider');
  return api;
}

export function TooltipProvider({ children }: { children: ReactNode }): ReactNode {
  const [subject, setSubject] = useState<TooltipSubject | null>(null);
  const { refs, floatingStyles } = useFloating({
    open: subject !== null,
    // Below the card, left-aligned with it — not beside it. A loadout row is a
    // comparison two cards wide, and a panel opening to the side of either card
    // lands on the other one: exactly the item the reader is comparing against.
    // Below, it covers the rows underneath, which are not part of the
    // comparison. `flip` puts it above when there is no room below.
    placement: 'bottom-start',
    middleware: [offset(8), flip(), shift({ padding: 10 })],
    whileElementsMounted: autoUpdate,
  });

  // Both are called from `mouseover`, which fires again on every boundary the
  // pointer crosses *inside* one item's face. Returning the previous subject
  // when nothing changed is what keeps that from re-rendering the panel — and
  // the whole window under it — on the way from an icon to a name.
  const show = useCallback(
    (element: Element, item: UiItem) => {
      refs.setPositionReference(anchorFor(element));
      setSubject((prev) => (prev?.kind === 'item' && prev.item === item ? prev : { kind: 'item', item }));
    },
    [refs],
  );
  const showSocketable = useCallback(
    (element: Element, label: string, part: UiSocketable, note?: string) => {
      refs.setPositionReference(anchorFor(element));
      setSubject((prev) =>
        prev?.kind === 'socketable' && prev.part === part && prev.note === note
          ? prev
          : { kind: 'socketable', label, part, ...(note ? { note } : {}) },
      );
    },
    [refs],
  );
  const hide = useCallback(() => setSubject(null), []);
  const api = useMemo(() => ({ show, showSocketable, hide }), [show, showSocketable, hide]);

  return (
    <TooltipContext.Provider value={api}>
      {children}
      {subject && (
        <FloatingPortal>
          <div ref={refs.setFloating} style={floatingStyles} className="tooltip-layer">
            <Tooltip subject={subject} />
          </div>
        </FloatingPortal>
      )}
    </TooltipContext.Provider>
  );
}
