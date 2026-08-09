/**
 * What the advisor actually said, under the loadout it says it about.
 *
 * The thesis, the key moves, and the per-slot table — the table rendered from
 * the plan's own fields rather than from the model's prose, which is what stops
 * the terminal and the window disagreeing about which verdicts are swaps.
 *
 * The prose is not thrown away: it is the human product of the run, and it sits
 * behind a second tab. Two tabs rather than one long column because they answer
 * different questions — the plan is what to *do*, the answer is why — and the
 * plan is the one you act from, so it opens first.
 *
 * With no run yet this is a short statement of what a run costs and produces,
 * not an empty box: an advice call takes about eight minutes and real money,
 * and a button that does not say so is a trap.
 */

import { useState } from 'react';

import { adviceMarks, staleIds } from '../../../shared/advice-marks.js';
import type { AdviseEnvelope, UiItem, UiSnapshot, UiSocketable } from '../../../shared/ipc.js';
import { adviceBySlot, holds, slotKey, socketMove } from '../advice.js';
import { useHighlight } from '../highlight.js';
import type { AdviseRun } from '../session.js';
import { useTooltip } from '../tooltip.js';
import { itemsByDocId } from './LoadoutPanel.js';
import { Markdown } from './Markdown.js';

export function AdvicePanel({
  snapshot,
  advice,
  run = null,
  error,
  onRun,
  onCancel,
}: {
  snapshot: UiSnapshot;
  advice: AdviseEnvelope | null;
  run?: AdviseRun | null;
  /** A start that was refused, or a run that died. Never a blank pane. */
  error?: string;
  onRun?: (question?: string) => void;
  onCancel?: () => void;
}): React.ReactNode {
  const highlight = useHighlight();
  const byId = itemsByDocId(snapshot);
  // The row's Action cell names a component or an augment; the plan is where its
  // id lives, because a socket move keeps the item and `nextId` is reserved for
  // the one verdict that swaps it.
  const bySlot = adviceBySlot(advice);
  const [tab, setTab] = useState<'plan' | 'answer'>('plan');
  const [question, setQuestion] = useState('');
  const running = run !== null;

  /** The run control, in both the empty and the answered states. */
  const control = running ? (
    <RunProgress run={run} {...(onCancel ? { onCancel } : {})} />
  ) : (
    <button
      type="button"
      className="run-button"
      onClick={() => onRun?.(question.trim() || undefined)}
      disabled={!onRun}
      title="Compiles the dossier and asks the model — about eight minutes"
    >
      {advice ? 'Re-run' : 'Run advice'}
    </button>
  );

  /**
   * The extra instruction, offered rather than required.
   *
   * It is a plain input rather than a dialog because most runs want nothing here
   * — the dossier already asks the whole question — and the ones that do want one
   * sentence ("I am rerolling for bleeding", "ignore the two-hander").
   */
  const ask = !running && (
    <input
      className="advice-question"
      type="text"
      value={question}
      placeholder="Anything to steer the answer? (optional)"
      onChange={(e) => setQuestion(e.target.value)}
      disabled={!onRun}
    />
  );

  if (!advice) {
    return (
      <section className="advice-panel empty">
        <header className="advice-header">
          <h2>Advice</h2>
          {control}
        </header>
        {/* The same paragraph in two tenses. Saying "no run yet" beside a
            spinner is the one thing this box may not do: it is the only text on
            screen, so it has to be about what is actually happening. */}
        {running ? (
          <p className="advice-placeholder">
            Compiling the whole reachable loadout for <b>{snapshot.character}</b> — equipped gear, both weapon
            sets, bags, stashes, blueprints and faction stock — into one dossier, and asking the model to rank
            every slot. The run is held in the app itself, so this window can be left alone or reloaded without
            losing it.
          </p>
        ) : (
          <p className="advice-placeholder">
            No run for <b>{snapshot.character}</b> yet. A run compiles the whole reachable loadout — equipped
            gear, both weapon sets, bags, stashes, blueprints and faction stock — into one dossier and asks the
            model to rank every slot. It takes about eight minutes and costs a few dollars of model time.
          </p>
        )}
        {ask}
        {error && <p className="advice-error">{error}</p>}
      </section>
    );
  }

  const plan = advice.plan;
  const held = holds(advice);
  // Document ids are only reproducible from identical save + database state, so a
  // save the game has rewritten since the run yields ids that simply fail to
  // join. Said out loud, by name: an item silently missing from the advice is
  // indistinguishable from advice that never mentioned it.
  const stale = staleIds(adviceMarks(plan), (id) => byId.has(id));
  return (
    <section className="advice-panel">
      <header className="advice-header">
        <h2>Advice</h2>
        <span className="advice-meta">
          {new Date(advice.generatedAt).toLocaleString()} · {advice.model ?? advice.provider}
          {advice.revised ? ' · revised once' : ''}
          {advice.warnings.length > 0 ? ` · ${advice.warnings.length} check warning(s)` : ' · checks clean'}
        </span>
        {control}
      </header>

      {ask}
      {error && <p className="advice-error">{error}</p>}

      <div className="tab-strip advice-tabs">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`tab ${tab === key ? 'selected' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'answer' && (
        <div className="advice-answer">
          {advice.answer ? <Markdown source={advice.answer} /> : <p className="empty-note">this run wrote no prose</p>}
        </div>
      )}

      {tab === 'plan' && (
        <>
          {plan?.summary && <p className="advice-summary">{plan.summary}</p>}

          {plan?.keyMoves && plan.keyMoves.length > 0 && (
            <ol className="key-moves">
              {plan.keyMoves.map((move, i) => (
                <li
                  key={i}
                  onMouseEnter={() => highlight.highlight(move.itemIds)}
                  onMouseLeave={() => highlight.highlight(null)}
                >
                  <b>{move.title}</b>
                  {move.detail && <span className="move-detail"> — {move.detail}</span>}
                </li>
              ))}
            </ol>
          )}

          {/*
            Gains and costs get a full-width line under their row, exactly as
            they do in the loadout. In a fifth column they were a stack of
            one-per-line fragments squeezed into whatever the four name columns
            left over, which set the height of every row by its longest stat
            string. Below, they read as a sentence and the columns above stay a
            table. One `<tbody>` per verdict is what keeps the pair a single
            row-group — and what lets the hover and the click cover both lines.
          */}
          <div className="table-scroll">
          <table className="verdict-table">
            {/*
              Proportional widths with `table-layout: fixed`, because the
              natural layout does not fit: four columns of auto-sized names came
              to 735 px inside a 689 px panel, and the pane clips rather than
              scrolls, so the Action column was being cut off at the app's own
              window size. Fixed shares out whatever width there is instead —
              and nothing an ellipsis hides is lost, because the two item cells
              carry the item's own tooltip and the rest carry a `title`.
            */}
            <colgroup>
              <col className="col-slot" />
              <col className="col-current" />
              <col className="col-new" />
              <col className="col-action" />
            </colgroup>
            <thead>
              <tr>
                <th>Slot</th>
                <th>Current</th>
                <th>New</th>
                <th>Action</th>
              </tr>
            </thead>
            {advice.verdictRows.map((row, i) => {
              const detail = row.gains.length > 0 || row.costs.length > 0 || row.why;
              return (
                <tbody
                  key={i}
                  className={row.replaces ? 'replaces' : ''}
                  // Both halves of the move: what comes off and what goes on. The
                  // reader is comparing two items, so lighting one is half an answer.
                  onMouseEnter={() => highlight.highlight([row.currentId, row.nextId])}
                  onMouseLeave={() => highlight.highlight(null)}
                  onClick={() => {
                    const item = byId.get(row.nextId);
                    if (item) highlight.requestReveal(item.docId, item.position);
                  }}
                >
                  <tr>
                    <th scope="row" title={row.slot}>
                      {row.slot}
                    </th>
                    {/* The two item cells get the real item panel, not just the
                        ellipsis-rescuing `title`: this table is where a reader
                        decides whether to act on a move, and deciding means
                        reading the stats of both items. The `title` stays as the
                        fallback for an id the snapshot has never heard of —
                        a stale save, or the `unknown-id` check firing. */}
                    <ItemCellText id={row.currentId} name={row.currentName} byId={byId} />
                    <ItemCellText id={row.nextId} name={row.replaces ? row.nextName : ''} byId={byId} />
                    <ActionCell
                      action={row.action}
                      socketable={socketableFor(bySlot, snapshot, row.slot)}
                      why={row.why}
                    />
                  </tr>
                  {detail && (
                    <tr className="verdict-detail">
                      <td colSpan={4}>
                        {row.gains.map((g) => (
                          <span className="gain" key={g}>
                            {g}
                          </span>
                        ))}
                        {row.costs.map((c) => (
                          <span className="cost" key={c}>
                            {c}
                          </span>
                        ))}
                        {row.why && <span className="why">{row.why}</span>}
                      </td>
                    </tr>
                  )}
                </tbody>
              );
            })}
          </table>
          </div>

          {held.length > 0 && (
            <div className="hold-list">
              <h3>Hold</h3>
              <ul>
                {held.map((h) => (
                  <li
                    key={h.itemId}
                    // A hold is about two items as much as a swap is: the one
                    // being kept and the one it will displace.
                    onMouseEnter={() => highlight.highlight([h.itemId, h.beats])}
                    onMouseLeave={() => highlight.highlight(null)}
                    onClick={() => {
                      const it = byId.get(h.itemId);
                      if (it) highlight.requestReveal(it.docId, it.position);
                    }}
                  >
                    <b>{byId.get(h.itemId)?.display ?? advice.itemNames[h.itemId] ?? h.itemId}</b>
                    {h.until && <span className="hold-until"> until {h.until}</span>}
                    {/* What the hold is *for*. Without it a hold list is a list
                        of things you cannot wear, which is not advice. */}
                    {h.slot && (
                      <span className="hold-for">
                        {' '}
                        for {h.slot}
                        {h.beats && ` over ${byId.get(h.beats)?.display ?? advice.itemNames[h.beats] ?? h.beats}`}
                      </span>
                    )}
                    {h.gains.map((g) => (
                      <span className="gain" key={g}>
                        {' '}
                        {g}
                      </span>
                    ))}
                    {h.reason && <span className="move-detail"> — {h.reason}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {stale.length > 0 && (
        <p className="advice-stale">
          {stale.length} item{stale.length === 1 ? '' : 's'} in this answer{' '}
          {stale.length === 1 ? 'is' : 'are'} no longer present — moved or changed since the run:{' '}
          {stale.map((id) => advice.itemNames[id] ?? advice.socketableNames[id] ?? `#${id}`).join(', ')}. Re-run to
          bring the advice back onto the save.
        </p>
      )}

      {advice.warnings.length > 0 && (
        <ul className="advice-warnings">
          {advice.warnings.map((w, i) => (
            <li key={i}>
              [{w.kind}] {w.message}
            </li>
          ))}
        </ul>
      )}

      {/* What the run cost, stated. Two calls and four dollars is the kind of
          fact a user should not have to go to a terminal for — and `calls: 2` is
          also the only visible sign that the repair loop fired. */}
      <div className="advice-cost">
        {advice.calls} call{advice.calls === 1 ? '' : 's'} ·{' '}
        {advice.usage.inputTokens.toLocaleString()} in · {advice.usage.outputTokens.toLocaleString()} out
        {advice.usage.costUsd > 0 ? ` · $${advice.usage.costUsd.toFixed(2)}` : ''} ·{' '}
        {formatDuration(advice.durationMs)}
        {advice.effort ? ` · effort ${advice.effort}` : ''}
        {advice.question ? ` · asked: “${advice.question}”` : ''}
      </div>
    </section>
  );
}

/** `495s` under a minute-ish, `8m 15s` past it — nobody counts 495 of anything. */
function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 90 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/**
 * A run in flight: which of the three things is happening, how long it has been
 * happening, and a way out.
 *
 * **No progress bar.** The call is one opaque subprocess that takes about eight
 * minutes and reports nothing until it is finished, so any percentage would be
 * an invention — and an invented bar that sits at 40% for six minutes is worse
 * than an honest clock, because it makes the user distrust the whole panel. The
 * phases are the three things that genuinely happen and the clock is real.
 */
function RunProgress({ run, onCancel }: { run: AdviseRun; onCancel?: () => void }): React.ReactNode {
  return (
    <span className="advice-run">
      <span className="spinner" aria-hidden />
      <span className="run-phase">{PHASE_LABEL[run.phase] ?? 'working'}</span>
      <span className="run-clock">{formatDuration(run.elapsedMs)}</span>
      <button type="button" className="run-button cancel" onClick={onCancel} disabled={!onCancel}>
        Cancel
      </button>
    </span>
  );
}

/**
 * The user's words for the three phases.
 *
 * `repair` is spelled "revising" because that is what it looks like from
 * outside: the plan failed a mechanical check and the model is being shown its
 * own warnings. "Repairing" would suggest something broke.
 */
const PHASE_LABEL: Readonly<Record<string, string>> = {
  context: 'building the dossier',
  asking: 'asking the model',
  repair: 'revising the plan',
};

/**
 * One item's name in the verdict table, with its full tooltip on hover.
 *
 * `mouseover` for the same reason the loadout cards use it: it bubbles, so the
 * panel is re-asserted whichever part of the cell the pointer crossed to get
 * here — including on the way back from the neighbouring cell, which is the
 * move a reader comparing two items makes constantly.
 */
function ItemCellText({
  id,
  name,
  byId,
}: {
  id: string;
  name: string;
  byId: Map<string, UiItem>;
}): React.ReactNode {
  const tooltip = useTooltip();
  const item = id ? byId.get(id) : undefined;
  if (!item) return <td title={name}>{name}</td>;
  return (
    <td
      className="has-tooltip"
      onMouseOver={(e) => tooltip.show(e.currentTarget, item)}
      onMouseLeave={tooltip.hide}
    >
      {name}
    </td>
  );
}

/**
 * The socketable a row's Action proposes, when it proposes one.
 *
 * The same lookup the loadout does: the plan names it by `targetId`, and the
 * snapshot's socketable dictionary has its stats — which the item cells cannot
 * supply, because a proposed component is installed nowhere.
 */
function socketableFor(
  bySlot: ReturnType<typeof adviceBySlot>,
  snapshot: UiSnapshot,
  slot: string,
): { part: UiSocketable; kind: string } | undefined {
  const move = socketMove(bySlot.get(slotKey(slot)));
  const part = move ? snapshot.socketables[move.id] : undefined;
  // The verdict says which socket it goes in, so the panel is labelled with the
  // one the reader is about to fill rather than a guess.
  return part && move ? { part, kind: move.kind === 'augment' ? 'Augment' : 'Component' } : undefined;
}

/**
 * The Action cell: `KEEP`, or a socket move and what it installs.
 *
 * Where it names a socketable, that socketable's own panel is what the reader
 * wants — the whole question about `ADD-COMPONENT Mark of Mogdrogen` is what
 * the Mark does. Where it does not, the `title` still rescues an ellipsis.
 */
function ActionCell({
  action,
  socketable,
  why,
}: {
  action: string;
  socketable: { part: UiSocketable; kind: string } | undefined;
  /** The advisor's sentence about this move — the second half of "why this one?". */
  why: string;
}): React.ReactNode {
  const tooltip = useTooltip();
  if (!socketable) return <td title={action}>{action}</td>;
  return (
    <td
      className="has-tooltip"
      onMouseOver={(e) => tooltip.showSocketable(e.currentTarget, socketable.kind, socketable.part, why)}
      onMouseLeave={tooltip.hide}
    >
      {action}
    </td>
  );
}

/** The plan is what to do and the answer is why; you act from the plan. */
const TABS: readonly (readonly ['plan' | 'answer', string])[] = [
  ['plan', 'Plan'],
  ['answer', 'Full answer'],
];
