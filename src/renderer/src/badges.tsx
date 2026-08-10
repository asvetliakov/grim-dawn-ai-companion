/**
 * One glyph per thing the plan can ask you to do.
 *
 * The mapping lives here and nowhere else, so the mark on an item cell, the
 * swatch in the legend and the heading of the action tooltip cannot end up
 * saying three different things about one verdict.
 *
 * **Hand-drawn rather than `lucide-react`.** The plan named that package; the
 * repo takes no runtime dependencies, and Stage 7A already declined
 * `react-markdown` on the same grounds and was right to. Nine glyphs at 12 px
 * are nine `<path>`s — a 1.5 MB icon library for them would be the largest
 * thing in the bundle by an order of magnitude, and every one of these needs to
 * read at 12 px inside a 32 px cell, which is a constraint a general-purpose
 * icon set does not share.
 *
 * The colour is **not** here. It comes from the action kind, which is what the
 * legend explains — see `advice.ts`. The plan's blue-for-socket-moves was
 * dropped for the same reason those glyphs rarely appear on a cell at all: a
 * socket verdict's subject is the item you are *wearing*, and worn items are not
 * in a container. A fourth colour with nothing to colour is not a distinction.
 */

import type { ActionKind } from './advice.js';
import type { AdviceMark, MarkVerdict } from '../../shared/advice-marks.js';

export interface Badge {
  glyph: React.ReactNode;
  /** Said out loud, for the `title` and for the tooltip heading. */
  label: string;
}

/** Every glyph is drawn in this box, so they all optically match at 12 px. */
function Glyph({ children }: { children: React.ReactNode }): React.ReactNode {
  return (
    <svg
      className="badge-glyph"
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

/**
 * Keyed by the plan's own vocabulary plus the three things that are not
 * verdicts. `destroy` is separate from the verdict that causes it on purpose:
 * what happens to an extraction *host* is not what happens to the slot the
 * component is going into, and the host is the item the reader is pointing at.
 */
export type BadgeKey = MarkVerdict | 'hold' | 'sell' | 'destroy';

const BADGES: Readonly<Record<BadgeKey, Badge>> = {
  // Up and out of the container it is sitting in.
  EQUIP: { glyph: <Glyph><path d="M8 13V4" /><path d="M4 8l4-4 4 4" /></Glyph>, label: 'Equip' },
  // The default state; here only so the record is total.
  KEEP: { glyph: <Glyph><path d="M3.5 8.5l3 3 6-7" /></Glyph>, label: 'Keep' },
  // A socket that is empty: nothing comes out, something goes in.
  'ADD-COMPONENT': { glyph: <Glyph><path d="M8 4v8" /><path d="M4 8h8" /></Glyph>, label: 'Add a component' },
  // A socket that is not: the two arrows are the exchange, and the exchange is
  // what destroys the component already in there.
  'SWAP-COMPONENT': {
    glyph: <Glyph><path d="M3 6h8l-2.5-2.5" /><path d="M13 10H5l2.5 2.5" /></Glyph>,
    label: 'Swap the component',
  },
  'RE-AUGMENT': {
    glyph: <Glyph><path d="M3 6h8l-2.5-2.5" /><path d="M13 10H5l2.5 2.5" /></Glyph>,
    label: 'Change the augment',
  },
  'BUY-AUGMENT': {
    glyph: <Glyph><path d="M8 3.5v9" /><path d="M10.5 5.5A2 2 0 008.5 4h-1a2 2 0 000 4h1a2 2 0 010 4h-1a2 2 0 01-2-1.5" /></Glyph>,
    label: 'Buy an augment',
  },
  // A hammer: this one does not exist yet.
  CRAFT: {
    glyph: <Glyph><path d="M4 12l5-5" /><path d="M8 4l4 4" /><path d="M9.5 2.5l4 4" /></Glyph>,
    label: 'Craft',
  },
  // A clock, in the colour the threshold is written in. Not a to-do: a hold is
  // "on the day the threshold is met, you will put this on".
  hold: { glyph: <Glyph><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.2l2 1.3" /></Glyph>, label: 'Hold' },
  // Coins.
  sell: {
    glyph: <Glyph><ellipse cx="8" cy="4.8" rx="4.5" ry="2" /><path d="M3.5 4.8v6.4c0 1.1 2 2 4.5 2s4.5-.9 4.5-2V4.8" /><path d="M3.5 8c0 1.1 2 2 4.5 2s4.5-.9 4.5-2" /></Glyph>,
    label: 'Sell or salvage',
  },
  // Struck through: the extraction spends this item, and nothing recovers it.
  destroy: { glyph: <Glyph><circle cx="8" cy="8" r="5.5" /><path d="M4.5 4.5l7 7" /></Glyph>, label: 'Destroyed' },
};

/**
 * The badge for one mark.
 *
 * Destruction wins over the verdict that caused it, because the verdict is about
 * a different slot: `SWAP-COMPONENT` on the boots is not what is happening to
 * the sword the component is being pulled out of.
 */
export function badgeForMark(mark: AdviceMark): Badge {
  if (mark.destroys) return BADGES.destroy;
  if (mark.kind === 'hold') return BADGES.hold;
  if (mark.kind === 'sell') return BADGES.sell;
  return BADGES[mark.verdict ?? 'KEEP'];
}

/** The badge a whole *kind* of action is drawn with — the legend's swatch. */
export function badgeForKind(kind: ActionKind): Badge {
  return kind === 'equip' ? BADGES.EQUIP : BADGES[kind];
}

/**
 * The mark as it appears in a cell's corner.
 *
 * `title` rather than a caption: the full sentence is in the action tooltip a
 * hover away, and a 32 px cell has room for a glyph. The colour comes from the
 * `action-*` class its container already carries.
 */
export function AdviceBadge({ mark }: { mark: AdviceMark }): React.ReactNode {
  const badge = badgeForMark(mark);
  const target = mark.targetName ? ` → ${mark.targetName}` : '';
  return (
    <span className="advice-badge" title={`${badge.label}${target}`}>
      {badge.glyph}
    </span>
  );
}

/**
 * The one mark that speaks for a cell.
 *
 * An item can be several things at once — a candidate for one slot and the
 * extraction host for another — and a 32 px cell has room for one glyph. The
 * order is the order the consequences matter in: what is destroyed first,
 * because it cannot be undone.
 */
export function primaryMark(marks: readonly AdviceMark[]): AdviceMark | undefined {
  const rank = (m: AdviceMark): number =>
    m.destroys ? 0 : m.incoming ? 1 : m.kind === 'sell' ? 2 : m.kind === 'hold' ? 3 : 4;
  return [...marks].sort((a, b) => rank(a) - rank(b))[0];
}

/**
 * How a slot stands against the run, as a glyph.
 *
 * Drawn in the same 16-box as every other glyph in this file so they match
 * optically, and given the same shapes the rest of the window already uses for
 * these meanings: `KEEP`'s tick for a move that has been made, a half-filled
 * circle for one part-way through — progress, not a verdict — and a triangle for
 * the one state in the loadout that wants a second look. A word alone was legible
 * and needed reading; the pair is recognisable at a glance in an 84 px column.
 */
export const SLOT_STATE_GLYPH: Readonly<Record<'done' | 'partial' | 'changed', React.ReactNode>> = {
  done: (
    <Glyph>
      <path d="M3.5 8.5l3 3 6-7" />
    </Glyph>
  ),
  partial: (
    <Glyph>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5a5.5 5.5 0 010 11z" fill="currentColor" stroke="none" />
    </Glyph>
  ),
  changed: (
    <Glyph>
      <path d="M8 3l5.5 10h-11z" />
      <path d="M8 7v2.6" />
      <path d="M8 11.4h.01" />
    </Glyph>
  ),
};
