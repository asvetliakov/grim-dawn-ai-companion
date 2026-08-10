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

import { useEffect, useRef, useState } from 'react';

import { adviceMarks, staleIds } from '../../../shared/advice-marks.js';
import { answerProse } from '../../../shared/answer.js';
import type {
  AdviceRunRef,
  AdviseActivityState,
  AdviseEnvelope,
  UiItem,
  UiSnapshot,
  UiSocketable,
} from '../../../shared/ipc.js';
import { adviceBySlot, holds, loadoutDrift, slotKey, socketMove } from '../advice.js';
import { useHighlight } from '../highlight.js';
import type { AdviseRun, RunActivity } from '../session.js';
import { useTooltip } from '../tooltip.js';
import { ExplainedButton } from './ExplainedButton.js';
import { currentWorn, itemsByDocId } from './LoadoutPanel.js';
import { Markdown } from './Markdown.js';

export function AdvicePanel({
  snapshot,
  advice,
  run = null,
  activity,
  error,
  history = [],
  onRun,
  onCancel,
  onNewRun,
}: {
  snapshot: UiSnapshot;
  advice: AdviseEnvelope | null;
  run?: AdviseRun | null;
  /** What the model has written — live, and afterwards until the next run. */
  activity?: RunActivity;
  /** A start that was refused, or a run that died. Never a blank pane. */
  error?: string;
  /** Every stored run for this character, newest first — the empty state counts them. */
  history?: readonly AdviceRunRef[];
  onRun?: (question?: string) => void;
  onCancel?: () => void;
  /** Put the open answer away and offer a fresh run. Deletes nothing. */
  onNewRun?: () => void;
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

  /**
   * The run control — and, with an answer on screen, deliberately **not a
   * Re-run**.
   *
   * A second opinion costs another eight minutes and a few dollars and does not
   * replace the answer beside it, so a Re-run button next to a finished plan is an
   * expensive misclick waiting to happen. Asking again is two steps on purpose:
   * `New run` puts this answer away (it stays in the picker), and the Run button
   * comes back with the question box.
   */
  const control = running ? (
    <RunProgress run={run} {...(activity ? { activity } : {})} {...(onCancel ? { onCancel } : {})} />
  ) : advice ? null : (
    <ExplainedButton
      className="run-button"
      label="Run advice"
      disabled={!onRun}
      onClick={() => onRun?.(question.trim() || undefined)}
      note={{
        title: 'Ask the model what to change',
        body: 'Everything this character can reach goes to the model in one go — worn gear, both weapon sets, bags, stashes, learned blueprints and what the factions will sell you — and it comes back with a recommendation for every slot. Takes about eight minutes and a few dollars.',
      }}
    />
  );

  /**
   * The extra instruction, offered rather than required.
   *
   * It is a plain input rather than a dialog because most runs want nothing here
   * — the dossier already asks the whole question — and the ones that do want one
   * sentence ("I am rerolling for bleeding", "ignore the two-hander").
   *
   * It belongs to the run that is about to start, so it appears with the Run
   * button and nowhere else: over a finished answer it was a box that steered
   * nothing, and over a live run there is nothing left to steer.
   */
  const ask = !running && !advice && (
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
          <div className="header-spacer" />
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
            Nothing open for <b>{snapshot.character}</b>. A run compiles the whole reachable loadout — equipped
            gear, both weapon sets, bags, stashes, blueprints and faction stock — into one dossier and asks the
            model to rank every slot. It takes about eight minutes and costs a few dollars of model time.
            {/* The window starts here every time rather than reopening the newest
                answer, so the empty state has to say that the old ones are still
                there — otherwise starting fresh looks like having lost them. */}
            {history.length > 0 && (
              <>
                {' '}
                <span className="advice-kept">
                  {history.length} earlier answer{history.length === 1 ? '' : 's'} {history.length === 1 ? 'is' : 'are'}{' '}
                  kept — open {history.length === 1 ? 'it' : 'one'} from the list in the top bar.
                </span>
              </>
            )}
          </p>
        )}
        {activity && (running || activity.text.trim() !== '') && (
          <ActivityLog activity={activity} running={running} />
        )}
        {ask}
        {error && <p className="advice-error">{error}</p>}
      </section>
    );
  }

  const plan = advice.plan;
  const held = holds(advice);
  const prose = answerProse(advice.answer);
  // Document ids are only reproducible from identical save + database state, so a
  // save the game has rewritten since the run yields ids that simply fail to
  // join. Said out loud, by name: an item silently missing from the advice is
  // indistinguishable from advice that never mentioned it.
  const stale = staleIds(adviceMarks(plan), (id) => byId.has(id));
  // Which rows have already been carried out. The *notices* about this live at the
  // top of the loadout, next to the gear they are about — see `DriftNotice`; here
  // it is only needed to strike the finished rows through.
  const doneSlots = new Set(
    loadoutDrift(advice, currentWorn(snapshot))
      .filter((d) => d.applied)
      .map((d) => slotKey(d.slot)),
  );
  return (
    <section className="advice-panel">
      <header className="advice-header">
        <h2>Advice</h2>
        {/* Which answer this is. The control that *switches* answers lives in the
            top bar and only there — the panel scrolls with the loadout, so a
            picker down here was sometimes off screen and always a duplicate. */}
        <span className="advice-meta">{new Date(advice.generatedAt).toLocaleString()}</span>
        <span className="advice-meta">
          {advice.model ?? advice.provider}
          {advice.revised ? ' · revised once' : ''}
          {advice.warnings.length > 0 ? ` · ${advice.warnings.length} check warning(s)` : ' · checks clean'}
        </span>
        <div className="header-spacer" />
        {/*
          Where `Clear` used to be, doing something else.

          `Clear` deleted the run it sat beside, which put a four-dollar answer one
          click from gone — and, worse, put it there under the button a reader
          reaches for *after acting on the plan*, when what they mean is "I have
          done these, let me ask again". That is now what it does: the answer is
          kept and this only stops showing it.
        */}
        {onNewRun && (
          <ExplainedButton
            className="run-button subtle"
            label="New run"
            disabled={running}
            onClick={onNewRun}
            note={{
              title: 'Put this answer away and start fresh',
              body: 'Nothing is deleted and nothing is spent — this answer stays in the list at the top of the panel, and you can open it again whenever you like. Use it when you have changed something the plan did not mention and want to ask again.',
            }}
          />
        )}
        {control}
      </header>

      {/* After the run, a transcript that never received any text has nothing
          to re-open — current models redact the reasoning stream — so the box
          only outlives the run when there is something in it. */}
      {activity && (running || activity.text.trim() !== '') && (
        <ActivityLog activity={activity} running={running} />
      )}
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

      {/* The prose, without the plan block that ends it. Everything in that block
          is already on the Plan tab as something hoverable and clickable; as raw
          JSON it was 17k of the answer's 28k on the first live run, which buries
          the argument the run was actually for. `answerProse` explains itself. */}
      {tab === 'answer' && (
        <div className="advice-answer">
          {prose ? <Markdown source={prose} /> : <p className="empty-note">this run wrote no prose</p>}
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
                  onMouseEnter={() => highlight.highlight(move.itemIds, { spotlight: true })}
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
                  // A row whose move has already been carried out is struck
                  // through rather than removed: the reader wants to see that it
                  // was on the list, and the argument for it is still the reason
                  // the rest of the plan hangs together.
                  className={`${row.replaces ? 'replaces' : ''} ${doneSlots.has(slotKey(row.slot)) ? 'done' : ''}`}
                  // Both halves of the move: what comes off and what goes on. The
                  // reader is comparing two items, so lighting one is half an answer.
                  onMouseEnter={() => highlight.highlight([row.currentId, row.nextId], { spotlight: true })}
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
                    onMouseEnter={() => highlight.highlight([h.itemId, h.beats], { spotlight: true })}
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

          {/*
            The ladder: what to spend next and what it buys. §12 of the dossier
            costs *every* blocked candidate, and without this section the reader
            is left holding that costing and no verdict on it — but the section
            is the plan's commitments, not the ladder re-typed. A live gpt-5.6
            run mirrored all sixteen rungs back, fourteen of them "skip,
            off-build", each unlock rendered here as a name to go and find in a
            stash tab: two hundred words telling the reader to hunt down gear
            the same answer advises against. `uncommitted-next-level` is the
            check, so an unlock here is an item the plan holds.

            An attribute line is one decision, not one per item, which is why
            these are thresholds with items hanging off them rather than items
            with thresholds. Hovering an entry lights everything it unlocks.
          */}
          {plan?.nextLevels && plan.nextLevels.length > 0 && (
            <div className="next-levels">
              <h3>Next levels</h3>
              <ul>
                {plan.nextLevels.map((step, i) => (
                  <li
                    key={i}
                    onMouseEnter={() => highlight.highlight(step.unlocks, { spotlight: true })}
                    onMouseLeave={() => highlight.highlight(null)}
                  >
                    <b className="level-threshold">{step.threshold}</b>
                    {step.unlocks.length > 0 && (
                      <span className="level-unlocks">
                        {' '}
                        unlocks{' '}
                        {step.unlocks.map((id, j) => {
                          const item = byId.get(id);
                          return (
                            <span key={id}>
                              {j > 0 && ', '}
                              {/* Clickable for the same reason a verdict row is:
                                  an unlock is routinely in a stash tab that is
                                  not on screen, and the first live reader went
                                  hunting for one by eye. Clicking jumps the
                                  containers to it. */}
                              <span
                                className={item ? 'level-item' : ''}
                                onClick={() => {
                                  if (item) highlight.requestReveal(item.docId, item.position);
                                }}
                              >
                                {item?.display ?? advice.itemNames[id] ?? `#${id}`}
                              </span>
                            </span>
                          );
                        })}
                      </span>
                    )}
                    {step.recommendation && <span className="move-detail"> — {step.recommendation}</span>}
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
        {(advice.usage.costUsd ?? 0) > 0
          ? ` · $${advice.usage.costUsd!.toFixed(2)}`
          : // No figure at all is a codex-cli run billing the ChatGPT
            // subscription; saying so beats a line that reads as "free".
            advice.usage.costUsd === undefined && advice.provider === 'codex-cli'
            ? ' · included in the subscription'
            : ''}{' '}
        ·{' '}
        {formatDuration(advice.durationMs)}
        {advice.effort ? ` · effort ${advice.effort}` : ''}
        {advice.question ? ` · asked: “${advice.question}”` : ''}
        {/* Scope is part of the answer's identity: a run that never saw the
            stashes is not wrong about them, it was not asked about them. */}
        {advice.stashIncluded === false ? ' · stash left out' : ''}
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
function RunProgress({
  run,
  activity,
  onCancel,
}: {
  run: AdviseRun;
  activity?: RunActivity;
  onCancel?: () => void;
}): React.ReactNode {
  return (
    <span className="advice-run">
      <span className="spinner" aria-hidden />
      <span className="run-phase">{PHASE_LABEL[run.phase] ?? 'working'}</span>
      {/* What it is doing *inside* the phase — the phase label says "asking the
          model" for ten minutes either way. Written tokens rather than a
          percentage: it is a real number that only goes up, and it makes no claim
          about how much is left. */}
      {activity && (
        <span className="run-activity">
          {activity.kind === 'thinking' ? 'thinking' : 'writing'}
          {activity.outputTokens ? ` · ${activity.outputTokens.toLocaleString()} tokens` : ''}
        </span>
      )}
      <span className="run-clock">{formatDuration(run.elapsedMs)}</span>
      <button type="button" className="run-button cancel" onClick={onCancel} disabled={!onCancel}>
        Cancel
      </button>
    </span>
  );
}

/**
 * The model's reasoning — all of it, while it is written and afterwards.
 *
 * The first version showed a 600-character tail on the argument that the panel has
 * two lines to spare and the transcript is not the product. Both true, and both
 * beside the point: this is a model reasoning about the reader's own build for ten
 * minutes, and *"why did it decide that"* is a question the finished answer
 * routinely raises and does not answer. So it is kept whole, and the panel's job
 * is only to stay out of the way — **expanded while the run is live, collapsed
 * once it ends**, and re-openable after that.
 *
 * The reasoning, and **only** the reasoning. The first live run streamed the
 * answer through here too, and that buried the transcript twice over: thirty
 * thousand tokens of markdown shoved the reasoning off the top mid-run, and the
 * repair call then re-streamed a whole second answer under it — so what the box
 * mostly showed was two copies of a document the panel was about to render
 * properly anyway. Now the answer's progress is a token count on the header line
 * (`RunProgress` shows the same), and the box holds the one thing that exists
 * nowhere else once the run ends.
 *
 * Not persisted with the envelope. It is the working-out, not the answer, and a
 * stored transcript beside a stored answer invites the two to be compared as if
 * both were conclusions. It lives until the next run replaces it.
 *
 * The scroll is pinned to the bottom **only while the run is live and only if the
 * reader has not scrolled away**: yanking someone back to the end of a paragraph
 * they were reading is worse than letting the tail run on without them.
 */
function ActivityLog({ activity, running }: { activity: RunActivity; running: boolean }): React.ReactNode {
  // `null` means "follow the run" — expanded while it is live, collapsed after.
  // A click pins it either way, because by then the reader has an opinion.
  const [pinned, setPinned] = useState<boolean | null>(null);
  const open = pinned ?? running;
  const box = useRef<HTMLPreElement | null>(null);
  const stuck = useRef(true);

  useEffect(() => {
    const el = box.current;
    if (!el || !open || !running || !stuck.current) return;
    el.scrollTop = el.scrollHeight;
  }, [activity.text, open, running]);

  const lines = activity.text.split('\n');
  const lastLine = lines.filter((l) => l.trim() !== '').pop() ?? '';
  // Current models redact the reasoning stream — every thinking delta arrives
  // as an empty string, and only the token estimate moves. The box still earns
  // its place while the run is live (the count is the heartbeat), but it has to
  // say why it is otherwise blank rather than looking broken.
  const silent = activity.text.trim() === '';

  return (
    <div className={`activity-log ${open ? 'open' : ''}`}>
      <button type="button" className="activity-head" onClick={() => setPinned(!open)}>
        <span className="activity-caret" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
        {/* The label says what the *model* is doing; the box always holds the
            reasoning. While the answer is being written the reasoning is done,
            and the token count is the live part. */}
        <span className="activity-kind">
          {running && activity.kind === 'answer' ? 'reasoning · the answer is being written' : 'reasoning'}
        </span>
        {activity.outputTokens ? (
          <span className="activity-count">{activity.outputTokens.toLocaleString()} tokens</span>
        ) : null}
        {/* Collapsed, the newest line is the whole point — it is what says the run
            is alive. Expanded, it would be a duplicate of the last line below. */}
        {!open && <span className="activity-peek">{lastLine}</span>}
      </button>
      {open && silent && (
        <p className="activity-silent">
          This model keeps its reasoning to itself — nothing to read here. The token count above is the live
          part: it only moves while the model is working.
        </p>
      )}
      {open && !silent && (
        <pre
          className="activity-text"
          ref={box}
          onScroll={(e) => {
            const el = e.currentTarget;
            stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {activity.partial && (
            <span className="activity-note">
              …this window joined the run in progress, so the earlier reasoning is not here.{'\n'}
            </span>
          )}
          {activity.text}
        </pre>
      )}
    </div>
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
