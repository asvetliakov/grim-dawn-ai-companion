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

import type { AdviceMark } from '../../../shared/advice-marks.js';
import type { UiItem, UiSocketable } from '../../../shared/ipc.js';
import { badgeForMark } from '../badges.js';
import { statClass } from '../statColors.js';
import { rarityClass } from '../rarity.js';

export type TooltipSubject =
  | { kind: 'item'; item: UiItem }
  | { kind: 'socketable'; label: string; part: UiSocketable; note?: string }
  /**
   * A control explaining itself.
   *
   * The window's expensive and destructive buttons — Run advice, Clear, Refresh —
   * need more than a label: a run is eight minutes and a few dollars, Clear
   * deletes one, and "does Refresh interrupt a run?" is a question every user
   * asks once. Native `title` was carrying that and carrying it badly: it takes
   * about a second to appear, renders in the OS's own style, and disappears while
   * being read. This borrows the panel the rest of the window already uses —
   * instant, legible, and it stays put while the pointer is on it.
   */
  | { kind: 'note'; title: string; body: string };

export function Tooltip({ subject }: { subject: TooltipSubject }): React.ReactNode {
  if (subject.kind === 'item') return <ItemTooltip item={subject.item} />;
  if (subject.kind === 'note') {
    return (
      // The `tooltip` class is what makes it a panel: the dark ground, the border,
      // the shadow, and the pointer-events that let it be read at leisure. Without
      // it this was styled text floating on whatever it happened to cover.
      <div className="tooltip control-note">
        <div className="control-note-title">{subject.title}</div>
        <div className="control-note-body">{subject.body}</div>
      </div>
    );
  }
  return (
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

      {/* The item is itself a socketable — a loose component or augment. Same
          line, same spelling, as the chip an installed one gets. */}
      {t.useOn && <div className="tooltip-note">use-on: {t.useOn}</div>}

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

/**
 * What the plan says about the item under the pointer — a **second** panel,
 * beside the item's own rather than inside it.
 *
 * Beside, because they answer different questions and have different lifetimes.
 * The item panel is what the item *is*, and it is true whether or not a run has
 * ever happened; this is what the last run thinks you should do about it, and it
 * is gone the moment you re-run. Folding advice into the item's own stat block
 * would make an opinion look like a property of the item.
 *
 * One panel per mark, because an item can be several things at once: the
 * candidate for one slot and the host an extraction spends for another. Those are
 * two instructions, and the second is not a footnote to the first.
 */
export function ActionTooltip({ marks }: { marks: readonly AdviceMark[] }): React.ReactNode {
  if (marks.length === 0) return null;
  return (
    <div className="tooltip action-tooltip">
      {marks.map((mark, i) => {
        const badge = badgeForMark(mark);
        return (
          <div className="action-block" key={i}>
            <div className="action-head">
              <span className="action-badge">{badge.glyph}</span>
              {/* Verb and object in one line: "Swap the component → Seal of
                  Blades" is the whole instruction, and a reader who reads
                  nothing else has still been told what to do. */}
              <span className="action-verb">{badge.label}</span>
              {mark.targetName && <span className="action-target">→ {mark.targetName}</span>}
              {mark.slot && <span className="action-slot">{mark.slot}</span>}
            </div>
            {/* A hold's threshold is the reason it is a hold rather than an
                equip, so it is not buried in the prose. */}
            {mark.until && <div className="action-until">until {mark.until}</div>}
            {/* What to put in it once you have it. Part of the instruction, not a
                footnote: the stats the swap was argued on are partly the
                component's, so an EQUIP carried out bare is not the move. */}
            {mark.fits?.map((fit) => (
              <div className="action-fit" key={`${fit.kind}:${fit.id}`}>
                fit {fit.kind}: {fit.name ?? `#${fit.id}`}
              </div>
            ))}
            {(mark.gains.length > 0 || mark.costs.length > 0) && (
              <div className="action-delta">
                {mark.gains.map((g) => (
                  <span className="gain" key={g}>
                    {g}
                  </span>
                ))}
                {mark.costs.map((c) => (
                  <span className="cost" key={c}>
                    {c}
                  </span>
                ))}
              </div>
            )}
            {mark.reason && <div className="action-reason">{mark.reason}</div>}
            {mark.keyMoves.map((title) => (
              <div className="action-keymove" key={title}>
                part of: {title}
              </div>
            ))}
          </div>
        );
      })}
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
