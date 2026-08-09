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

import type { AdviseEnvelope, UiSnapshot } from '../../../shared/ipc.js';
import { holds } from '../advice.js';
import { useHighlight } from '../highlight.js';
import { itemsByDocId } from './LoadoutPanel.js';
import { Markdown } from './Markdown.js';

export function AdvicePanel({
  snapshot,
  advice,
  onRun,
  running,
}: {
  snapshot: UiSnapshot;
  advice: AdviseEnvelope | null;
  onRun?: () => void;
  running?: boolean;
}): React.ReactNode {
  const highlight = useHighlight();
  const byId = itemsByDocId(snapshot);
  const [tab, setTab] = useState<'plan' | 'answer'>('plan');

  if (!advice) {
    return (
      <section className="advice-panel empty">
        <header className="advice-header">
          <h2>Advice</h2>
          <button type="button" className="run-button" onClick={onRun} disabled={running || !onRun}>
            {running ? 'Thinking…' : 'Run advice'}
          </button>
        </header>
        <p className="advice-placeholder">
          No run for <b>{snapshot.character}</b> yet. A run compiles the whole reachable loadout —
          equipped gear, both weapon sets, bags, stashes, blueprints and faction stock — into one
          dossier and asks the model to rank every slot. It takes several minutes.
        </p>
      </section>
    );
  }

  const plan = advice.plan;
  const held = holds(advice);
  return (
    <section className="advice-panel">
      <header className="advice-header">
        <h2>Advice</h2>
        <span className="advice-meta">
          {new Date(advice.generatedAt).toLocaleString()} · {advice.model ?? advice.provider}
          {advice.revised ? ' · revised once' : ''}
          {advice.warnings.length > 0 ? ` · ${advice.warnings.length} check warning(s)` : ' · checks clean'}
        </span>
        <button type="button" className="run-button" onClick={onRun} disabled={running || !onRun}>
          {running ? 'Thinking…' : 'Re-run'}
        </button>
      </header>

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
          <table className="verdict-table">
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
                    <th scope="row">{row.slot}</th>
                    <td>{row.currentName}</td>
                    <td>{row.replaces ? row.nextName : ''}</td>
                    <td>{row.action}</td>
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

      {advice.warnings.length > 0 && (
        <ul className="advice-warnings">
          {advice.warnings.map((w, i) => (
            <li key={i}>
              [{w.kind}] {w.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The plan is what to do and the answer is why; you act from the plan. */
const TABS: readonly (readonly ['plan' | 'answer', string])[] = [
  ['plan', 'Plan'],
  ['answer', 'Full answer'],
];
