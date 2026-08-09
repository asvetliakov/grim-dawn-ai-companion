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
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type { UiItem, UiSocketable } from '../../shared/ipc.js';
import { ActionTooltip, Tooltip, type TooltipSubject } from './components/ItemTooltip.js';
import { useAdviceMarks, useHoldHighlight } from './highlight.js';

interface TooltipApi {
  show: (element: Element, item: UiItem) => void;
  showSocketable: (element: Element, label: string, part: UiSocketable, note?: string) => void;
  /** A control explaining what it does. See the `note` subject in `ItemTooltip`. */
  showNote: (element: Element, title: string, body: string) => void;
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

/**
 * Whether an element still has room to scroll the way the wheel is turning.
 *
 * Both halves matter. `overflow-y` says whether it is a scroller at all, and the
 * position says whether it has anywhere left to go — an element pinned at its
 * bottom must hand the wheel on rather than swallow it, which is the difference
 * between a panel that scrolls and a panel that traps.
 */
function canScrollBy(el: Element, delta: number): boolean {
  if (!/(auto|scroll)/.test(getComputedStyle(el).overflowY)) return false;
  const max = el.scrollHeight - el.clientHeight;
  if (max <= 1) return false;
  return delta < 0 ? el.scrollTop > 0 : el.scrollTop < max - 1;
}

/** The pane an element lives in — the thing that scrolls when the wheel turns. */
function scrollableAncestor(el: Element | null | undefined): Element | undefined {
  for (let node = el ?? null; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight - node.clientHeight > 1) {
      return node;
    }
  }
  return undefined;
}

/**
 * How much of the outstanding distance to cover each frame.
 *
 * Chromium animates a wheel notch over roughly a tenth of a second rather than
 * jumping it, and a forwarded scroll that jumps is exactly what makes the panel
 * feel like a different surface from the pane beside it. At 60 Hz this covers
 * ~70% of a notch in five frames, which lands in the same place by the same kind
 * of curve. Higher reads as a jump; lower drags behind the fingers.
 */
const EASE = 0.22;

/**
 * Above this, a wheel event is a discrete notch rather than a gesture.
 *
 * The two input devices want opposite things, and the browser gives them
 * opposite things over an ordinary scroller: a trackpad streams small deltas at
 * screen rate and is applied 1:1, while a mouse notch arrives as one ~100 px
 * event and is *animated*. Easing a trackpad would put the scroll ~4 frames
 * behind the fingers, which is precisely the lag this is meant to remove.
 * Chromium's own notch on macOS is 100–120 px and trackpad deltas rarely pass
 * 40, momentum included.
 */
const NOTCH_DELTA = 40;

/**
 * Forwarding a wheel delta onto another element, the way the browser would.
 *
 * The naive `pane.scrollTop += deltaY` is correct and feels wrong: a mouse notch
 * lands in one frame where the same notch over the container is animated. So a
 * notch accumulates into a remainder that a `requestAnimationFrame` loop eases
 * out, and a gesture is passed straight through. Mixed input stays coherent
 * because a small delta arriving mid-animation joins the remainder rather than
 * racing it.
 *
 * The loop stops when the remainder is spent *or* when the pane has stopped
 * moving — at the end of its range the remainder would otherwise decay towards
 * zero for a second of frames, doing nothing.
 */
function useForwardedScroll(): (pane: Element, delta: number) => void {
  const state = useRef({ pane: null as Element | null, remaining: 0, frame: 0 });

  // A pending frame outliving the component would scroll a detached pane.
  useEffect(() => () => cancelAnimationFrame(state.current.frame), []);

  return useCallback((pane: Element, delta: number) => {
    const s = state.current;
    // A different pane means a different gesture; its remainder is not ours.
    if (s.pane !== pane) {
      s.remaining = 0;
      cancelAnimationFrame(s.frame);
      s.frame = 0;
    }
    s.pane = pane;

    // A gesture, with nothing already in flight: 1:1, exactly as the container
    // itself would have handled it.
    if (!s.frame && Math.abs(delta) <= NOTCH_DELTA) {
      pane.scrollTop += delta;
      return;
    }

    s.remaining += delta;
    if (s.frame) return;

    const step = (): void => {
      const target = s.pane;
      if (!target || Math.abs(s.remaining) < 0.5) {
        s.frame = 0;
        s.remaining = 0;
        return;
      }
      const move = Math.abs(s.remaining) < 2 ? s.remaining : s.remaining * EASE;
      const before = target.scrollTop;
      target.scrollTop = before + move;
      const moved = target.scrollTop - before;
      // Nothing moved: the pane is at one end of its range, so the rest of the
      // remainder has nowhere to go.
      s.remaining = moved === 0 ? 0 : s.remaining - move;
      s.frame = s.remaining === 0 ? 0 : requestAnimationFrame(step);
    };
    s.frame = requestAnimationFrame(step);
  }, []);
}

/**
 * How long the panel outlives the pointer leaving its target.
 *
 * The panel is a hover target itself — a long item's stats are worth reading at
 * leisure, and worth selecting — and it sits 8 px below the card, so a close on
 * `mouseleave` would fire in the gap and the panel would vanish on the way to
 * it. Long enough to cross that gap without hurrying, short enough that a panel
 * opened by a pointer passing through is gone before it is read as sticky.
 */
const HIDE_DELAY_MS = 220;

/**
 * How long the pointer has to rest on something before its panel appears.
 *
 * Every change waits, not only the first: the window is a grid of two hundred
 * items and every path across it passes over a dozen, so a panel that followed
 * the pointer immediately would strobe on the way to anywhere. An earlier draft
 * delayed only the cold open and switched instantly after that, on the theory
 * that a reader comparing items has already asked to see them — but it made the
 * two cases feel like different controls, and the strobe came straight back the
 * moment a panel was up.
 *
 * The old panel stays put while the new one waits, so this reads as the panel
 * settling rather than as a gap.
 */
const OPEN_DELAY_MS = 200;

const TooltipContext = createContext<TooltipApi | undefined>(undefined);

export function useTooltip(): TooltipApi {
  const api = useContext(TooltipContext);
  if (!api) throw new Error('useTooltip outside a TooltipProvider');
  return api;
}

/**
 * The advice half of the panel, looked up rather than passed in.
 *
 * Every call site would otherwise have to thread the marks through `show`, and
 * there are a dozen of them — a grid cell, a loadout card, a verdict row, a
 * material row — none of which knows anything about advice today. The lookup is
 * a `Map.get` in a context, and it answers nothing at all when there is no
 * `HighlightProvider` above, which is how the isolated stories keep working.
 */
function AdviceNote({ subject }: { subject: TooltipSubject }): ReactNode {
  const marks = useAdviceMarks(subject.kind === 'item' ? subject.item.docId : undefined);
  return <ActionTooltip marks={marks} />;
}

export function TooltipProvider({ children }: { children: ReactNode }): ReactNode {
  const [subject, setSubject] = useState<TooltipSubject | null>(null);
  // The card the panel describes stays lit while the panel is up. See
  // `holdHighlight` for why this is a second set rather than a sticky pointer.
  const hold = useHoldHighlight();
  const { refs, floatingStyles } = useFloating({
    open: subject !== null,
    // Below the subject and **centred on it** — not beside it, and no longer
    // left-aligned with it.
    //
    // Below rather than beside, because a loadout row is a comparison two cards
    // wide and a panel opening to the side of either card lands on the other one:
    // exactly the item the reader is comparing against. Below, it covers the rows
    // underneath, which are not part of the comparison. `flip` puts it above when
    // there is no room below.
    //
    // Centred rather than left-aligned, because the layer holds *two* panels for a
    // marked item. Left-aligned, the pair extended right from the card until it hit
    // the viewport, at which point `shift` slid the whole thing left — so the
    // item's own panel sat somewhere different depending on whether the plan had
    // anything to say about that item, and jumped as the pointer crossed from a
    // marked cell to an unmarked one. Centred, the pair grows symmetrically and
    // `shift` has far less to correct.
    placement: 'bottom',
    middleware: [offset(8), flip(), shift({ padding: 10 })],
    whileElementsMounted: autoUpdate,
  });

  // The pending close, so that arriving anywhere — a new card, or the panel
  // itself — cancels it. Without the cancel the delay would only postpone the
  // flicker rather than remove it.
  const closing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keep = useCallback(() => {
    if (closing.current !== undefined) {
      clearTimeout(closing.current);
      closing.current = undefined;
    }
  }, []);
  useEffect(() => keep, [keep]);

  // The card the panel is describing, kept so the wheel handler below knows
  // which pane to scroll. `refs.reference` holds the same thing, but as a
  // `ReferenceType` that may be a virtual element rather than a node.
  const anchor = useRef<Element | null>(null);
  /**
   * The subject, readable synchronously.
   *
   * `show` has to know whether a panel is *already* up before deciding between
   * the cold delay and an immediate switch, and it is called from an event
   * handler where `subject` is whatever it was at the last render.
   */
  const live = useRef<TooltipSubject | null>(null);
  /**
   * The pending change: what to show, what to show it against, and the timer.
   *
   * The anchor waits with the subject. Moving the position reference on hover
   * while the panel still holds the previous subject would slide that panel over
   * to the new card and describe the wrong item there for a fifth of a second.
   */
  const opening = useRef<
    { subject: TooltipSubject; anchor: Element; timer: ReturnType<typeof setTimeout> } | undefined
  >(undefined);

  const cancelOpen = useCallback(() => {
    if (opening.current) {
      clearTimeout(opening.current.timer);
      opening.current = undefined;
    }
  }, []);
  // A pending open that outlives the provider would set state on a dead tree.
  useEffect(() => cancelOpen, [cancelOpen]);

  /**
   * Ask for a subject. It arrives `OPEN_DELAY_MS` later, or not at all.
   *
   * Three cases, and the order matters. Already showing it — the pointer moved
   * *within* one card, which `mouseover` reports on every internal boundary —
   * cancels any pending change and does nothing else, so icon → chip → name
   * costs no renders and no re-delay. Already waiting for it: let the timer run
   * rather than pushing the deadline back, or moving inside a card would postpone
   * the panel forever. Anything else starts the wait afresh.
   */
  const present = useCallback(
    (element: Element, next: TooltipSubject, unchanged: (prev: TooltipSubject | null) => boolean) => {
      keep();
      if (unchanged(live.current)) {
        cancelOpen();
        return;
      }
      if (opening.current && unchanged(opening.current.subject)) return;

      cancelOpen();
      const target = anchorFor(element);
      opening.current = {
        subject: next,
        anchor: target,
        timer: setTimeout(() => {
          const pending = opening.current;
          opening.current = undefined;
          if (!pending) return;
          // The wait outlives fast UI: a run finishing swaps the button under a
          // stationary pointer, and a panel anchored to an unmounted element is
          // positioned against nothing — floating-ui parks it at the viewport's
          // top-left, over whatever lives there, with no mouseleave ever coming.
          if (!pending.anchor.isConnected) return;
          // The anchor moves *with* the subject: the panel must not slide to the
          // new card while it is still describing the old one.
          anchor.current = pending.anchor;
          refs.setPositionReference(pending.anchor);
          live.current = pending.subject;
          setSubject(pending.subject);
          // The card the panel describes stays lit for as long as the panel is
          // up — including while the pointer is on the panel itself, where the
          // pointer highlight has necessarily gone. A socketable subject holds
          // whatever the item before it held, which is right: the chip belongs to
          // that item, and it is still the thing on screen.
          if (pending.subject.kind === 'item') hold(pending.subject.item.docId);
        }, OPEN_DELAY_MS),
      };
    },
    [refs, keep, cancelOpen, hold],
  );

  const show = useCallback(
    (element: Element, item: UiItem) => {
      present(
        element,
        { kind: 'item', item },
        (prev) => prev?.kind === 'item' && prev.item === item,
      );
    },
    [present],
  );
  const showSocketable = useCallback(
    (element: Element, label: string, part: UiSocketable, note?: string) => {
      present(
        element,
        { kind: 'socketable', label, part, ...(note ? { note } : {}) },
        (prev) => prev?.kind === 'socketable' && prev.part === part && prev.note === note,
      );
    },
    [present],
  );
  const showNote = useCallback(
    (element: Element, title: string, body: string) => {
      present(
        element,
        { kind: 'note', title, body },
        (prev) => prev?.kind === 'note' && prev.title === title && prev.body === body,
      );
    },
    [present],
  );
  const hide = useCallback(() => {
    // A pointer that leaves before the delay elapses never wanted the panel.
    cancelOpen();
    keep();
    closing.current = setTimeout(() => {
      closing.current = undefined;
      live.current = null;
      setSubject(null);
      hold(null);
    }, HIDE_DELAY_MS);
  }, [keep, cancelOpen, hold]);
  const api = useMemo(
    () => ({ show, showSocketable, showNote, hide }),
    [show, showSocketable, showNote, hide],
  );

  /**
   * A panel whose subject has left the document closes itself.
   *
   * Nothing else can close it: `hide` rides the anchor's `mouseleave`, and an
   * unmounted anchor fires no events — so a tab switch (or any re-render that
   * replaces a hovered control) orphaned the panel at the viewport's top-left,
   * over the column tabs, swallowing clicks until something happened to brush
   * it. Polled rather than observed: a MutationObserver on the whole tree costs
   * more than four checks a second on the rare frames a panel is open at all.
   */
  useEffect(() => {
    if (!subject) return;
    const timer = setInterval(() => {
      if (anchor.current && !anchor.current.isConnected) {
        live.current = null;
        setSubject(null);
        hold(null);
      }
    }, 250);
    return () => clearInterval(timer);
  }, [subject, hold]);

  /**
   * The wheel, over the panel.
   *
   * The panel takes pointer events — it has to, so a long stat block can be read
   * at leisure and selected out of — and that made it a dead spot for scrolling:
   * it is portaled to the body, so the wheel reached neither the panel (nothing
   * to scroll) nor the pane underneath (not an ancestor). Two answers, in order.
   * A panel taller than the viewport scrolls itself. One with nothing left to
   * scroll passes the wheel to the pane the *card* is in, which is the pane the
   * panel is covering — so the wheel does what it would have done if the panel
   * were not there, and `autoUpdate` carries the panel along with its card.
   *
   * A **native** listener, because React registers `wheel` passively at the root
   * and `preventDefault` in a passive listener is ignored.
   *
   * The delta is *eased* rather than applied — see `useForwardedScroll`. Setting
   * `scrollTop` outright made a mouse notch jump its whole hundred pixels in one
   * frame, which reads as clunky beside the same notch over the container, where
   * Chromium animates it.
   */
  const forward = useForwardedScroll();
  const onWheel = useCallback(
    (event: WheelEvent): void => {
      const panel = event.currentTarget as Element;
      for (let el = event.target as Element | null; el; el = el.parentElement) {
        if (canScrollBy(el, event.deltaY)) return;
        if (el === panel) break;
      }
      const pane = scrollableAncestor(anchor.current);
      if (!pane) return;
      forward(pane, event.deltaY);
      event.preventDefault();
    },
    [forward],
  );

  /**
   * Attached from the ref callback rather than from an effect.
   *
   * `FloatingPortal` mounts its child in an effect of its own, so on the render
   * that opens the panel `refs.floating.current` is still null — an effect here
   * would find nothing to attach to and, since nothing it depends on changes
   * again, would never retry. The ref callback fires exactly when the node
   * appears, which is the only moment that is reliably right.
   */
  const panel = useRef<HTMLElement | null>(null);
  const setPanel = useCallback(
    (node: HTMLElement | null) => {
      panel.current?.removeEventListener('wheel', onWheel);
      panel.current = node;
      node?.addEventListener('wheel', onWheel, { passive: false });
      refs.setFloating(node);
    },
    [refs, onWheel],
  );

  return (
    <TooltipContext.Provider value={api}>
      {children}
      {subject && (
        <FloatingPortal>
          {/* The panel keeps itself open while the pointer is on it, and closes
              on the same delay when it leaves — so the reader can go into it to
              read a long stat block or select a line, and does not have to
              hurry back out. */}
          <div
            ref={setPanel}
            style={floatingStyles}
            className="tooltip-layer"
            onMouseEnter={keep}
            onMouseLeave={hide}
          >
            <Tooltip subject={subject} />
            {/* The advice panel sits beside the item's own, in the same layer, so
                the pair moves and flips as one thing and the reader never has to
                chase half of it across the window. */}
            <AdviceNote subject={subject} />
          </div>
        </FloatingPortal>
      )}
    </TooltipContext.Provider>
  );
}
