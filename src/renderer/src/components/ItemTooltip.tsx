/**
 * The hover panel — for a whole item, or for one socketable on its own.
 *
 * Every line here was rendered in the main process by the same formatter that
 * writes the context document, so this component decides *layout and colour*
 * and nothing else — it never computes, rounds or abbreviates a number. A
 * tooltip that disagreed with the dossier about what an item does would be
 * worse than no tooltip.
 *
 * Colour is the one thing it adds, and it is read back off the text: see
 * `statColors.ts` for why that is safe rather than fragile.
 */

import type { UiItem, UiSocketable } from '../../../shared/ipc.js';
import { rarityClass } from '../rarity.js';
import { statClass } from '../statColors.js';

export type TooltipSubject =
  | { kind: 'item'; item: UiItem }
  | { kind: 'socketable'; label: string; part: UiSocketable; note?: string };

export function Tooltip({ subject }: { subject: TooltipSubject }): React.ReactNode {
  return subject.kind === 'item' ? (
    <ItemTooltip item={subject.item} />
  ) : (
    <SocketableTooltip label={subject.label} part={subject.part} {...(subject.note ? { note: subject.note } : {})} />
  );
}

function StatLines({ lines }: { lines: readonly string[] }): React.ReactNode {
  return (
    <>
      {lines.map((line, i) => (
        <div className={`tooltip-line ${statClass(line)}`} key={i}>
          {line}
        </div>
      ))}
    </>
  );
}

export function ItemTooltip({ item }: { item: UiItem }): React.ReactNode {
  const t = item.tooltip;
  return (
    <div className="tooltip">
      <div className={`tooltip-title ${rarityClass(t.rarity)}`}>{t.title}</div>
      {t.typeLine && <div className="tooltip-type">{t.typeLine}</div>}
      {/* Which parts of that title are rolled affixes, rather than the base item. */}
      {t.affixes.length > 0 && <div className="tooltip-affixes">{t.affixes.join(' · ')}</div>}

      {t.blocks.map((block, i) => (
        <div className="tooltip-block" key={i}>
          {block.heading && <div className="tooltip-heading">{block.heading}</div>}
          <StatLines lines={block.lines} />
        </div>
      ))}

      {t.grantedSkills.length > 0 && (
        <div className="tooltip-block tooltip-granted">
          <StatLines lines={t.grantedSkills} />
        </div>
      )}

      {t.component && <SocketableBlock label="Component" part={t.component} />}
      {t.augment && <SocketableBlock label="Augment" part={t.augment} />}

      {t.sockets.length > 0 && (
        <div className="tooltip-block tooltip-sockets">
          {t.sockets.map((note, i) => (
            <div className="tooltip-line" key={i}>
              {note}
            </div>
          ))}
        </div>
      )}

      {t.requirements && (
        <div className={`tooltip-block tooltip-req ${t.meetsRequirements === false ? 'unmet' : ''}`}>
          {t.requirements.map((line, i) => (
            <div className="tooltip-line" key={i}>
              {line}
            </div>
          ))}
        </div>
      )}

      {t.unresolved.length > 0 && (
        <div className="tooltip-block tooltip-warn">
          {t.unresolved.map((record) => (
            <div className="tooltip-line" key={record}>
              unresolved record: {record}
            </div>
          ))}
        </div>
      )}

      <div className="tooltip-id">#{item.docId}</div>
    </div>
  );
}

/**
 * A component or augment hovered on its own, in the loadout or a grid.
 *
 * `note` is the advisor's own sentence about the move — why this component, in
 * this slot, now. It belongs here because the panel is what a reader is looking
 * at when they ask "and why this one?", and the stats above it answer only the
 * first half of that.
 */
export function SocketableTooltip({
  label,
  part,
  note,
}: {
  label: string;
  part: UiSocketable;
  note?: string;
}): React.ReactNode {
  return (
    <div className="tooltip">
      <div className="tooltip-title tooltip-socketable-title">{part.name}</div>
      <div className="tooltip-type">{label}</div>
      <div className="tooltip-block">
        <StatLines lines={part.lines} />
      </div>
      {part.useOn && <div className="tooltip-note">use-on: {part.useOn}</div>}
      {note && <div className="tooltip-why">{note}</div>}
    </div>
  );
}

function SocketableBlock({ label, part }: { label: string; part: UiSocketable }): React.ReactNode {
  return (
    <div className="tooltip-block tooltip-socketable">
      <div className="tooltip-heading">
        {label}: {part.name}
      </div>
      <StatLines lines={part.lines} />
      {part.useOn && <div className="tooltip-note">use-on: {part.useOn}</div>}
    </div>
  );
}
