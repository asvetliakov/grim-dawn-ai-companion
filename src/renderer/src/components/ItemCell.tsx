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
 * all. It is drawn as a corner flag rather than as a second border so that a
 * cell can be both at once and still read as one thing being pointed at, and it
 * is coloured by *what* the action is: putting something on now, keeping it for
 * later, and destroying it are three different instructions.
 */

import type { CSSProperties } from 'react';

import type { UiItem } from '../../../shared/ipc.js';
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
  const lit = highlight.isHighlighted(item.docId);
  const action = highlight.actionFor(item.docId);

  return (
    <div
      className={`item-cell ${rarityClass(item.rarity)} ${lit ? 'highlighted' : ''} ${
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
      {item.stackCount > 1 && <span className="item-stack">{item.stackCount}</span>}
    </div>
  );
}
