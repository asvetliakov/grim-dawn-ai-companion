/**
 * Current gear beside proposed gear, slot by slot.
 *
 * This replaces the in-game paper doll on purpose. The doll's arrangement
 * exists to wrap a rendered character, and there is no character here — what is
 * left is a lot of empty middle and no room for the one thing the tool is for,
 * which is comparing what you are wearing against what you could be. So each
 * slot is a row: what is equipped, an arrow, and what the advisor proposes.
 *
 * Until an advice run exists the right-hand side is locked rather than hidden.
 * An empty column that is obviously waiting for something says what the app
 * does; a column that is not there says nothing at all.
 *
 * The proposal is not always a different item. Four of the seven verdicts keep
 * the item and change what it *carries* — a new component, a different augment.
 * Those render as **the same item again**, with the new socketable in its
 * socket and the consequences in its tooltip, because that is what the slot
 * will actually look like afterwards: the reader is comparing two states of one
 * item, and showing them a lone component asks them to do that assembly in
 * their head.
 */

import { useState } from 'react';

import type { AdviseEnvelope, UiItem, UiSnapshot, UiSocketable } from '../../../shared/ipc.js';
import {
  adviceBySlot,
  loadoutDrift,
  shortVerdict,
  slotKey,
  socketFits,
  socketMove,
  type SlotAdvice,
  type SocketFit,
  type SlotDrift,
  type SocketMove,
  type WornSlot,
} from '../advice.js';
import { SLOT_STATE_GLYPH } from '../badges.js';
import { useHighlight } from '../highlight.js';
import { useTooltip } from '../tooltip.js';
import { ItemFace } from './ItemFace.js';

/** Slot order, head down — weapons first because a weapon swap moves the most. */
const LAYOUT: { slot: string; label: string }[] = [
  { slot: 'Head', label: 'Head' },
  { slot: 'main', label: 'Main hand' },
  { slot: 'off', label: 'Off hand' },
  { slot: 'Chest', label: 'Chest' },
  { slot: 'Hands', label: 'Hands' },
  { slot: 'Legs', label: 'Legs' },
  { slot: 'Feet', label: 'Feet' },
  { slot: 'Shoulders', label: 'Shoulders' },
  { slot: 'Belt', label: 'Belt' },
  { slot: 'Neck', label: 'Neck' },
  { slot: 'Medal', label: 'Medal' },
  { slot: 'Ring 1', label: 'Ring 1' },
  { slot: 'Ring 2', label: 'Ring 2' },
  { slot: 'Relic', label: 'Relic' },
];

/** Equipment array index by slot name, in the save's own order. */
const EQUIP_INDEX: Record<string, number> = {
  Head: 0,
  Neck: 1,
  Chest: 2,
  Legs: 3,
  Feet: 4,
  Hands: 5,
  'Ring 1': 6,
  'Ring 2': 7,
  Belt: 8,
  Shoulders: 9,
  Medal: 10,
  Relic: 11,
};

export function LoadoutPanel({
  snapshot,
  advice,
  weaponSet,
  onWeaponSet,
}: {
  snapshot: UiSnapshot;
  advice: AdviseEnvelope | null;
  weaponSet: 1 | 2;
  onWeaponSet: (set: 1 | 2) => void;
}): React.ReactNode {
  const bySlot = adviceBySlot(advice);
  const byId = itemsByDocId(snapshot);
  const heldSet: 1 | 2 = snapshot.alternateWeaponSetActive ? 2 : 1;
  const weapons = snapshot.weaponSets[weaponSet - 1] ?? [];

  const currentFor = (slot: string): UiItem | null => {
    if (slot === 'main') return weapons[0] ?? null;
    if (slot === 'off') return weapons[1] ?? null;
    const index = EQUIP_INDEX[slot];
    return index === undefined ? null : (snapshot.equipment[index] ?? null);
  };

  const adviceFor = (slot: string): SlotAdvice | undefined => {
    if (slot === 'main' || slot === 'off') {
      return bySlot.get(slotKey(`Weapon set ${weaponSet} ${slot}`));
    }
    return bySlot.get(slotKey(slot));
  };

  // Where the live loadout has moved away from the one the run was written for.
  // Two states per slot, and they are opposites: `applied` is the plan being
  // carried out, anything else is the plan being overtaken.
  const drift = loadoutDrift(advice, currentWorn(snapshot));
  const stateBySlot = new Map(drift.map((d) => [slotKey(d.slot), d.applied ? 'done' : 'changed'] as const));
  const stateFor = (slot: string): 'done' | 'changed' | undefined =>
    stateBySlot.get(slotKey(slot === 'main' || slot === 'off' ? `Weapon set ${weaponSet} ${slot}` : slot));

  return (
    <section className="loadout">
      <header className="loadout-header">
        <h2>Loadout</h2>
        <div className="weapon-switch">
          <span className="switch-label">Weapon set</span>
          {([1, 2] as const).map((set) => (
            <button
              key={set}
              type="button"
              className={`set-button ${set === weaponSet ? 'selected' : ''}`}
              onClick={() => onWeaponSet(set)}
              title={set === heldSet ? 'The set the character is holding' : 'The stowed set'}
            >
              {set === 1 ? 'I' : 'II'}
              {set === heldSet && <span className="held-dot" title="held" />}
            </button>
          ))}
        </div>
        {!advice && <span className="loadout-hint">Run advice to fill the right-hand column.</span>}
      </header>

      {/* At the top of the loadout, not in the advice panel below it: both notices
          are about *these fourteen rows*, and one of them changes how several of
          them should be read. Under the table they were an explanation arriving
          after the thing it explains. */}
      <DriftNotice drift={drift} advice={advice} byId={byId} />

      <div className="loadout-grid">
        {LAYOUT.map((entry) => (
          <SlotRow
            key={entry.slot}
            label={entry.label}
            current={currentFor(entry.slot)}
            advice={adviceFor(entry.slot)}
            byId={byId}
            socketables={snapshot.socketables}
            names={advice?.socketableNames ?? {}}
            hasAdvice={advice !== null}
            {...(stateFor(entry.slot) ? { state: stateFor(entry.slot)! } : {})}
          />
        ))}
      </div>
    </section>
  );
}

function SlotRow({
  label,
  current,
  advice,
  byId,
  socketables,
  names,
  hasAdvice,
  state,
}: {
  label: string;
  current: UiItem | null;
  advice: SlotAdvice | undefined;
  byId: Map<string, UiItem>;
  socketables: Record<string, UiSocketable>;
  names: Record<string, string>;
  hasAdvice: boolean;
  /**
   * How this slot stands against the run: `done` when it already holds what the
   * plan asked for, `changed` when it holds something the plan never mentioned.
   * Absent when the slot is exactly what the run was written against.
   */
  state?: 'done' | 'changed';
}): React.ReactNode {
  const highlight = useHighlight();
  const tooltip = useTooltip();
  const verdict = advice?.verdict ?? '';
  const done = state === 'done';

  // Anything the slot is told to fit that its verdict is not named for. It goes
  // on whichever card ends up being the proposal — the candidate for an EQUIP,
  // the worn item otherwise — because that is the item that will be carrying it.
  const fits = socketFits(advice);
  const candidate = advice?.replaces ? byId.get(advice.targetId) : undefined;
  const proposed = candidate ? withFits(candidate, fits, socketables, names) : undefined;

  // A socket move keeps the item, so the proposal is that same item with the
  // new socketable in place. The socketable's stats come from the snapshot's
  // dictionary — the same record the dossier offered it from; a plan naming an
  // id the snapshot has never heard of still renders, by name, rather than
  // vanishing.
  const socket = socketMove(advice);
  const afterSocket =
    socket && current
      ? withFits(
          withSocketable(current, socket, socketables[socket.id], names[socket.id], byId.get(socket.from ?? '')),
          fits,
          socketables,
          names,
        )
      : // A slot can be told to fit something with no socket *verdict* at all —
        // a free component fill beside a KEEP. That is still a changed item, so
        // it still gets a proposal card.
        fits.length > 0 && current
        ? withFits(current, fits, socketables, names)
        : undefined;

  const destroys = socket?.from ? (byId.get(socket.from)?.display ?? socket.from) : '';

  /**
   * Which of the row's two cards the highlight belongs to.
   *
   * A socket move proposes the *same item* — `withSocketable` copies it so the
   * tooltip is right for free — which means both cards carry one document id, and
   * an id-based highlight lights the pair. That reads as "this whole row" where
   * the reader pointed at one side of a comparison, so the row remembers which.
   *
   * Deliberately not cleared on leave: the panel keeps its subject lit while the
   * pointer is on it, and clearing here would take the card dark on the way. It
   * stops mattering the moment the id stops being highlighted at all.
   */
  const [side, setSide] = useState<'current' | 'proposed'>('current');
  // Only ambiguous when the two cards *are* the same item. For an EQUIP the ids
  // differ, and filtering by side there would stop a verdict row from lighting the
  // worn item just because the proposal was pointed at last.
  const ambiguous = afterSocket !== undefined;
  const litFor = (docId: string, which: 'current' | 'proposed'): boolean =>
    highlight.isHighlighted(docId) && (!ambiguous || side === which);

  return (
    <div
      className={`slot-row ${verdict ? `verdict-${verdict.toLowerCase()}` : ''} ${socket ? 'socket-move' : ''} ${
        state ?? ''
      }`}
    >
      {/* The label is a hover target too: at a glance you want the slot, and
          the item under it is what you then want to read. */}
      <div
        className="slot-name"
        onMouseEnter={(e) => current && tooltip.show(e.currentTarget, current)}
        onMouseLeave={tooltip.hide}
      >
        {label}
        {/* Under the slot name, because that is where the eye starts on a row and
            because it changes how the rest of the row should be read: a `DONE`
            row is a record, not an instruction. */}
        {state && (
          <span
            className={`slot-state ${state}`}
            title={
              done
                ? 'This slot already holds what the plan asked for.'
                : 'This slot holds something the plan did not ask for, so its verdict is about gear you are no longer wearing.'
            }
          >
            {SLOT_STATE_GLYPH[state]}
            {done ? 'DONE' : 'CHANGED'}
          </span>
        )}
      </div>

      <div className="slot-side slot-current">
        {current ? (
          // Lit by id, not by `:hover`. The two are usually the same thing, but
          // not while the pointer is on the item's own panel: the panel keeps its
          // subject lit so the card and its container copy do not go dark under a
          // reader half way through a stat block.
          <ItemFace
            item={current}
            highlighted={litFor(current.docId, 'current')}
            onHover={(docId) => docId && setSide('current')}
          />
        ) : (
          <div className="face-empty">empty</div>
        )}
      </div>

      {/* Every verdict, in one place, abbreviated so the column costs the two
          card columns as little as possible. It used to sit above the proposal
          for socket moves, because `SWAP-COMPONENT` spelled out did not fit
          here — and that pushed the proposed card a line lower than the worn
          one, which is the one thing a comparison row may not do. */}
      <div className="slot-arrow">
        {verdict ? (
          // A move already made keeps its word and loses its urgency: struck
          // through, because the reader wants to see that it was on the list.
          <span
            className={`verdict-tag ${done ? 'done' : ''}`}
            title={done ? `${verdict} — already done; this slot holds what the plan asked for` : verdict}
          >
            {shortVerdict(verdict)}
          </span>
        ) : (
          '→'
        )}
      </div>

      <div className="slot-side slot-proposed">
        {proposed ? (
          <ItemFace
            item={proposed}
            highlighted={highlight.isHighlighted(proposed.docId)}
            onHover={(id) => highlight.highlight(id, { spotlight: true })}
            onClick={() => highlight.requestReveal(proposed.docId, proposed.position)}
          />
        ) : afterSocket ? (
          <ItemFace
            item={afterSocket}
            // Which chip to mark as the one that changed. A fits-only proposal
            // has no socket verdict to ask, so the first fit answers instead.
            changed={socket?.kind ?? fits[0]?.kind ?? 'component'}
            // Two reasons this card can be lit, and it needs both. Its own id,
            // because a socket move proposes the *same item* and its panel holds
            // that subject — without this the card went dark the moment the
            // pointer moved onto the panel describing it. And the extraction
            // source, because that other item is part of the move too, exactly as
            // an EQUIP lights up the candidate it names.
            highlighted={
              litFor(afterSocket.docId, 'proposed') ||
              (socket?.from ? highlight.isHighlighted(socket.from) : false)
            }
            onHover={(docId) => {
              setSide('proposed');
              if (socket?.from) highlight.highlight(docId ? socket.from : null, { spotlight: true });
            }}
          />
        ) : advice ? (
          // A verdict that is not a replacement still has something to say —
          // "keep this", "hold until level 84", "craft that".
          <div className="face-note">
            {advice.row.action || advice.targetName || 'keep what is equipped'}
          </div>
        ) : (
          <div className={`face-locked ${hasAdvice ? '' : 'waiting'}`}>—</div>
        )}
      </div>

      {advice && (advice.row.gains.length > 0 || advice.row.costs.length > 0 || advice.row.why || destroys) && (
        <div className="slot-reason">
          {advice.row.gains.map((gain) => (
            <span className="gain" key={gain}>
              {gain}
            </span>
          ))}
          {advice.row.costs.map((cost) => (
            <span className="cost" key={cost}>
              {cost}
            </span>
          ))}
          {/* The one cost a socket move has that no swap does. It belongs with
              the other costs rather than above the card — the Inventor recovers
              the component *or* the item, so this is the price of the move, and
              a price is not a caption. It is in the proposal's tooltip too. */}
          {destroys && <span className="socket-destroys">destroys {destroys}</span>}
          {advice.row.why && <span className="why">{advice.row.why}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * The slot's item as it would be *after* the socket move.
 *
 * A derived `UiItem` rather than a set of props threaded into the face, so the
 * tooltip is right for free: it is the same tooltip component reading the same
 * shape, and there is no second rendering path to keep in agreement with the
 * first. What the copy changes is exactly what the move changes — one socket —
 * plus the socket notes, which is where the consequences belong: replacing an
 * installed component **destroys** it, applying an augment soulbinds the item,
 * and an extraction destroys the item it comes out of. A reader who hovers the
 * proposal is asking "what would I have"; those are part of the answer.
 *
 * `part` may be missing when the plan names a socketable the snapshot never
 * heard of. That renders by name with no stats rather than vanishing — the
 * `unknown-socketable` check has already said so in the warnings.
 */
function withSocketable(
  item: UiItem,
  move: SocketMove,
  part: UiSocketable | undefined,
  fallbackName: string | undefined,
  extractedFrom: UiItem | undefined,
): UiItem {
  const replaced = move.kind === 'component' ? item.tooltip.component : item.tooltip.augment;
  const next: UiSocketable = part ?? {
    name: move.name || fallbackName || move.id,
    lines: [],
    iconPath: null,
  };

  const notes: string[] = [];
  if (replaced) {
    notes.push(
      move.kind === 'component'
        ? `Replaces ${replaced.name} — the old component is destroyed`
        : `Replaces ${replaced.name} — the old augment is gone`,
    );
  } else {
    notes.push(`${move.kind === 'component' ? 'Component socket' : 'Augment slot'} was empty — this costs nothing`);
  }
  if (extractedFrom) notes.push(`Extracted from ${extractedFrom.display}, which the extraction destroys`);
  if (move.kind === 'augment') notes.push('Soulbound while the augment is applied');

  return {
    ...item,
    tooltip: {
      ...item.tooltip,
      [move.kind]: next,
      sockets: notes,
    },
  };
}

/**
 * The item with the plan's extra socketables in it.
 *
 * Same trick as `withSocketable` and for the same reason — a derived `UiItem`, so
 * the chips and the tooltip are right for free — but it applies to the card that
 * ends up being the proposal, whichever that is. For an `EQUIP` that is the
 * candidate, and this is what makes its card show what the reader is actually
 * being told to wear: an amulet with a Dread Skull in it has +24% Pierce Damage
 * that the bare amulet does not, and the argument for the swap was partly that
 * number.
 *
 * A note per fit rather than one for the pair: an empty socket costs nothing and
 * an occupied one destroys what is in it, and those are different sentences.
 */
function withFits(
  item: UiItem,
  fits: readonly SocketFit[],
  socketables: Record<string, UiSocketable>,
  names: Record<string, string>,
): UiItem {
  if (fits.length === 0) return item;

  let tooltip = item.tooltip;
  const notes = [...tooltip.sockets];
  for (const fit of fits) {
    const existing = fit.kind === 'component' ? tooltip.component : tooltip.augment;
    const part: UiSocketable = socketables[fit.id] ?? {
      name: fit.name ?? names[fit.id] ?? fit.id,
      lines: [],
      iconPath: null,
    };
    notes.push(
      existing
        ? `Fits ${part.name} in place of ${existing.name}, which is destroyed`
        : `Fits ${part.name} — the ${fit.kind === 'component' ? 'component socket' : 'augment slot'} was empty, so this costs nothing`,
    );
    if (fit.kind === 'augment') notes.push('Soulbound while the augment is applied');
    tooltip = { ...tooltip, [fit.kind]: part };
  }
  return { ...item, tooltip: { ...tooltip, sockets: notes } };
}

/**
 * How far the live loadout has moved from the one the run was written against.
 *
 * Two paragraphs, never one sentence, because the same comparison produces two
 * opposite facts. A slot that now holds what the plan asked for is the plan
 * **working** — and it is what a naive staleness check would report as the answer
 * having gone stale, which is why the two are separated at the source
 * (`loadoutDrift`) rather than phrased apart here.
 *
 * A socket change gets its own wording. An item's document id includes its
 * attachments, so installing a component changes the id of an item that is
 * otherwise untouched; saying "Feet now holds Bloodhound Greaves (was Bloodhound
 * Greaves)" would be both useless and backwards.
 */
function DriftNotice({
  drift,
  advice,
  byId,
}: {
  drift: readonly SlotDrift[];
  advice: AdviseEnvelope | null;
  byId: Map<string, UiItem>;
}): React.ReactNode {
  if (!advice || drift.length === 0) return null;
  const done = drift.filter((d) => d.applied);
  const moved = drift.filter((d) => !d.applied);
  const itemName = (id: string): string => byId.get(id)?.display ?? advice.itemNames[id] ?? `#${id}`;
  const partName = (id: string): string => advice.socketableNames[id] ?? `#${id}`;
  const phrase = (d: SlotDrift): string => {
    if (d.changed === 'sockets') {
      return d.socketNames.length > 0
        ? `${d.slot} now carries ${d.socketNames.map(partName).join(' and ')}`
        : `${d.slot}'s component and augment are gone`;
    }
    if (!d.nowId) return `${d.slot} is now empty`;
    return `${d.slot} now holds ${itemName(d.nowId)}${d.wasId ? ` (was ${itemName(d.wasId)})` : ''}`;
  };

  return (
    <>
      {done.length > 0 && (
        <p className="advice-done">
          {done.length} of this run's moves {done.length === 1 ? 'is' : 'are'} already done —{' '}
          {done.map(phrase).join('; ')}.
        </p>
      )}
      {moved.length > 0 && (
        <p className="advice-drift">
          Changed since this run, in {moved.length} slot{moved.length === 1 ? '' : 's'} the plan did not ask for:{' '}
          {moved.map(phrase).join('; ')}. Those verdicts are about gear the character is no longer wearing.
        </p>
      )}
    </>
  );
}

/**
 * What the character is wearing *now*, in the document's own slot labels.
 *
 * The mirror of the envelope's `worn`, built from the live snapshot so the two can
 * be compared key for key. The labels have to match the resolver's, which is why
 * this is here beside `EQUIP_INDEX` rather than anywhere more convenient: that
 * map and `EQUIP_SLOT_NAMES` in the core are the same twelve strings in the same
 * order, and the weapon labels are the dossier's own `Weapon set N main/off`.
 */
export function currentWorn(snapshot: UiSnapshot): Record<string, WornSlot> {
  const out: Record<string, WornSlot> = {};
  const entry = (item: UiItem): WornSlot => ({
    itemId: item.docId,
    display: item.display,
    // What it is carrying, so a component the reader has just installed reads as
    // the plan being carried out rather than as the item being replaced.
    ...(item.tooltip.component?.id ? { componentId: item.tooltip.component.id } : {}),
    ...(item.tooltip.augment?.id ? { augmentId: item.tooltip.augment.id } : {}),
  });

  for (const [slot, index] of Object.entries(EQUIP_INDEX)) {
    const item = snapshot.equipment[index];
    if (item) out[slot] = entry(item);
  }
  snapshot.weaponSets.forEach((set, i) => {
    const [main, off] = set;
    if (main) out[`Weapon set ${i + 1} main`] = entry(main);
    if (off) out[`Weapon set ${i + 1} off`] = entry(off);
  });
  return out;
}

/** Every item the character can reach, by document id — the join advice uses. */
export function itemsByDocId(snapshot: UiSnapshot): Map<string, UiItem> {
  const out = new Map<string, UiItem>();
  const add = (item: UiItem | null): void => {
    if (item) out.set(item.docId, item);
  };
  for (const item of snapshot.equipment) add(item);
  for (const set of snapshot.weaponSets) for (const item of set) add(item);
  for (const grid of [...snapshot.bags, ...snapshot.personalStash, ...snapshot.transferStash]) {
    for (const item of grid.items) add(item);
  }
  for (const item of snapshot.materials) add(item);
  return out;
}
