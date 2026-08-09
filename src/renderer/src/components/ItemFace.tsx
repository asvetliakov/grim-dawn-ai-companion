/**
 * One item, shown the way the loadout compares them: art, name, and the two
 * socketables underneath.
 *
 * The component and augment get their own small faces rather than being folded
 * into the item's tooltip, because they are the two things a swap most often
 * turns on — an empty component socket is a free upgrade, and an augment
 * soulbinds whatever it is applied to. Each has its own hover text.
 */

import { useState } from 'react';

import type { UiItem, UiSocketable } from '../../../shared/ipc.js';
import { useIconUrl } from '../icons.js';
import { rarityClass } from '../rarity.js';
import { useTooltip } from '../tooltip.js';

export function ItemFace({
  item,
  onHover,
  onClick,
  highlighted = false,
  changed,
}: {
  item: UiItem;
  onHover?: (docId: string | null) => void;
  onClick?: () => void;
  highlighted?: boolean;
  /** Which socket a proposal changes, when this face is a proposed version. */
  changed?: 'component' | 'augment';
}): React.ReactNode {
  const tooltip = useTooltip();

  return (
    <div
      // The *whole* face is the hover target, not the 46 px of icon in it. The
      // name is what the eye lands on and what the pointer goes to; requiring
      // the icon made the tooltip feel broken. The socket chips sit inside and
      // claim the pointer back for themselves, which is why they listen on
      // `mouseover` — see below.
      className={`item-face ${highlighted ? 'highlighted' : ''} ${onClick ? 'clickable' : ''}`}
      // `mouseover` bubbles, so this fires again every time the pointer moves
      // between the face's own parts — which is what puts the item's tooltip
      // back when the pointer leaves a socket chip for the name. `mouseenter`
      // would fire once on the way in and never again.
      onMouseOver={(e) => tooltip.show(e.currentTarget, item)}
      onMouseEnter={() => onHover?.(item.docId)}
      onMouseLeave={() => {
        onHover?.(null);
        tooltip.hide();
      }}
      {...(onClick ? { onClick } : {})}
    >
      <div className="face-art">
        <ItemArt item={item} />
      </div>
      <div className="face-text">
        <div className={`face-name ${rarityClass(item.rarity)}`}>{item.display}</div>
        <div className="face-sockets">
          <SocketChip
            label="C"
            kind="Component"
            part={item.tooltip.component}
            empty="no component"
            changed={changed === 'component'}
          />
          <SocketChip
            label="A"
            kind="Augment"
            part={item.tooltip.augment}
            empty="no augment"
            changed={changed === 'augment'}
          />
        </div>
      </div>
    </div>
  );
}

/** The icon itself, with the text fallback a missing texture falls back to. */
export function ItemArt({ item }: { item: UiItem }): React.ReactNode {
  const iconUrl = useIconUrl();
  const [broken, setBroken] = useState(false);
  if (item.iconPath === null || broken) {
    return <span className={`item-placeholder ${rarityClass(item.rarity)}`}>{initials(item.display)}</span>;
  }
  return (
    <img src={iconUrl(item.iconPath)} alt={item.display} draggable={false} onError={() => setBroken(true)} />
  );
}

/**
 * A component or augment: its own art where it has any, its name, and the full
 * stat list on hover.
 *
 * Shown beside the item rather than buried in its tooltip because these are the
 * two things a swap most often turns on — an empty component socket is the
 * cheapest upgrade in the game, and an augment soulbinds whatever it is applied
 * to. An absent one says so; a blank would read as "not applicable".
 */
function SocketChip({
  label,
  kind,
  part,
  empty,
  changed = false,
}: {
  label: string;
  kind: string;
  part: UiSocketable | undefined;
  empty: string;
  /** This is the socket a proposal changes — mark it, do not just show it. */
  changed?: boolean;
}): React.ReactNode {
  const iconUrl = useIconUrl();
  const tooltip = useTooltip();
  const [broken, setBroken] = useState(false);
  const showArt = part?.iconPath && !broken;
  return (
    <span
      className={`socket-chip ${part ? 'filled' : 'empty'} ${changed ? 'changed' : ''}`}
      title={part ? undefined : empty}
      // A socketable gets its *own* panel rather than the host item's: what a
      // component does is the thing a swap most often turns on, and reading it
      // should not mean reading the whole item again.
      //
      // `onMouseOver` rather than `onMouseEnter`, and the handler is on the
      // chip rather than on its parts: `mouseover` bubbles from whichever child
      // the pointer is actually over, so arriving at the name — from the icon,
      // from the item, from anywhere — re-asserts this tooltip instead of
      // leaving whatever the last leave handler did standing.
      // No leave handler on purpose: leaving the chip for the item's name is a
      // `mouseover` on the face, which puts the item back. A `hide` here would
      // race that, and the two orders give different answers.
      onMouseOver={(e) => {
        e.stopPropagation();
        if (part) tooltip.showSocketable(e.currentTarget, kind, part);
      }}
    >
      <span className="socket-art">
        {showArt ? (
          <img src={iconUrl(part.iconPath!)} alt="" draggable={false} onError={() => setBroken(true)} />
        ) : (
          label
        )}
      </span>
      {/* An empty socket is still worth seeing — it is the cheapest upgrade in
          the game — but naming it on every one of fourteen rows drowns the
          names that matter. The empty box says it; the hover text spells it. */}
      {part && <span className="socket-name">{part.name}</span>}
    </span>
  );
}

export function initials(display: string): string {
  return display
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
}
