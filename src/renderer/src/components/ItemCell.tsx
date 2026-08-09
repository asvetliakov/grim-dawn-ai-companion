/**
 * One item in a container grid.
 *
 * The `highlighted` state is what connects the two halves of the window:
 * pointing at a proposed item on the left lights up the same item where it
 * actually sits, so acting on the advice does not start with a hunt through
 * four containers.
 *
 * The action mark is the standing version of the same idea and answers the
 * earlier question — which of these two hundred items the advice touches at
 * all. It sits in the corner rather than being a second border so that a cell
 * can be both at once and still read as one thing being pointed at, and it is
 * coloured by *what* the action is: putting something on now, keeping it for
 * later, destroying it and selling it are four different instructions.
 *
 * It carries a glyph, not just a colour. Four colours need a legend to be read;
 * an arrow pointing up out of the cell does not, and the glyph is what makes the
 * mark survive being looked at without one.
 */

import type { CSSProperties } from 'react';

import type { UiItem } from '../../../shared/ipc.js';
import { AdviceBadge, primaryMark } from '../badges.js';
import { useHighlight } from '../highlight.js';
import { rarityClass } from '../rarity.js';
import { useTooltip } from '../tooltip.js';
import { ItemArt } from './ItemFace.js';

export function ItemCell({
  item,
  className = '',
  style,
}: {
  item: UiItem;
  className?: string;
  style?: CSSProperties;
}): React.ReactNode {
  const tooltip = useTooltip();
  const highlight = useHighlight();
  const action = highlight.actionFor(item.docId);
  // Two ways to be lit: the pointer is on this item (or on something that names
  // it), or the container legend is pointing at this whole kind of action —
  // which is how "sell or salvage 13" becomes thirteen visible cells.
  const lit = highlight.isHighlighted(item.docId) || (action !== undefined && action === highlight.litKind);
  // While the legend is pointing at a kind, everything that is *not* that kind
  // steps back — lighting thirteen cells in a bright grid of two hundred was
  // findable; thirteen lit cells over a dimmed field is legible at a glance.
  // A loadout/advice hover that names items asks for the same field via
  // `spotlight`; a plain grid hover never dims, so browsing stays calm.
  const dim =
    (highlight.litKind !== null && action !== highlight.litKind) || (highlight.spotlight && !lit);
  const mark = primaryMark(highlight.adviceFor(item.docId));

  return (
    <div
      className={`item-cell ${rarityClass(item.rarity)} ${lit ? 'highlighted' : ''} ${dim ? 'dimmed' : ''} ${
        action ? `action action-${action}` : ''
      } ${className}`}
      style={style}
      onMouseEnter={(e) => {
        tooltip.show(e.currentTarget, item);
        highlight.highlight(item.docId);
      }}
      onMouseLeave={() => {
        tooltip.hide();
        highlight.highlight(null);
      }}
    >
      <ItemArt item={item} />
      {mark && <AdviceBadge mark={mark} />}
      {item.stackCount > 1 && <span className="item-stack">{item.stackCount}</span>}
    </div>
  );
}
