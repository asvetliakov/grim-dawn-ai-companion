import { useEffect, useMemo, useRef, useState } from 'react';

import { adviceMarks } from '../../shared/advice-marks.js';
import type { AdviceRunRef, AdviseEnvelope, UiSnapshot } from '../../shared/ipc.js';
import { actionMarks } from './advice.js';
import { AdvicePanel } from './components/AdvicePanel.js';
import { ContainerPanel } from './components/ContainerPanel.js';
import { ContextViewer } from './components/ContextViewer.js';
import { Header } from './components/Header.js';
import { LoadoutPanel } from './components/LoadoutPanel.js';
import { SettingsPane } from './components/SettingsPane.js';
import { StatsPanel } from './components/StatsPanel.js';
import { HighlightProvider, useHighlight } from './highlight.js';
import { useSession, type AdviseRun, type RunActivity } from './session.js';
import { TooltipProvider } from './tooltip.js';

export function App(): React.ReactNode {
  const session = useSession();
  const {
    bootstrap,
    snapshot,
    advice,
    adviceHistory,
    adviceId,
    run,
    activity,
    adviceError,
    loading,
    progress,
    error,
    saveProblem,
    pane,
    detected,
  } = session;

  return (
    <Shell>
      <Header
        {...(bootstrap ? { bootstrap } : {})}
        {...(snapshot ? { snapshot } : {})}
        loading={loading}
        hasAdvice={advice !== undefined}
        runningAdvice={run !== null}
        history={adviceHistory}
        {...(adviceId ? { adviceId } : {})}
        onCharacter={session.setCharacter}
        onDifficulty={(difficulty) => session.updateSettings({ difficultyOverride: difficulty })}
        onRefresh={session.refresh}
        onRunAdvice={() => session.startAdvice()}
        onSelectAdvice={session.selectAdvice}
        onNewRun={session.newRun}
        onIncludeStash={(include) => session.updateSettings({ includeStashInAdvice: include })}
        onSettings={() => session.openPane('settings')}
      />

      {error && <div className="banner error">{error}</div>}
      {/*
        A save the watcher could not read is not the same as having nothing to
        show: the last good snapshot is still on screen, so this says the window
        has stopped keeping up rather than that it has failed.
      */}
      {saveProblem && !error && (
        <div className="banner warn-banner">
          Could not read the save Grim Dawn just wrote — showing the last one that read cleanly.
          <div className="banner-note">{saveProblem}</div>
        </div>
      )}
      {/* Progress shows even with a snapshot up: changing the locale or the game
          directory rebuilds the database, which is half a minute of silence
          otherwise. */}
      {loading && (!snapshot || progress) && <LoadingBanner progress={progress} />}

      {pane === 'settings' && (
        <SettingsPane
          {...(bootstrap ? { bootstrap } : {})}
          {...(snapshot ? { snapshot } : {})}
          {...(detected ? { detected } : {})}
          onChange={session.updateSettings}
          onShowContext={() => session.openPane('context')}
          onClose={() => session.openPane(undefined)}
        />
      )}
      {pane === 'context' && (
        <ContextViewer load={() => window.gd.getContextDocument()} onClose={() => session.openPane(undefined)} />
      )}

      {snapshot && (
        <Workspace
          snapshot={snapshot}
          advice={advice ?? null}
          run={run}
          {...(activity ? { activity } : {})}
          history={adviceHistory}
          {...(adviceError ? { adviceError } : {})}
          onRunAdvice={session.startAdvice}
          onCancelAdvice={session.cancelAdvice}
          onNewRun={session.newRun}
        />
      )}

      {snapshot && snapshot.warnings.length > 0 && (
        <div className="banner warn">
          {snapshot.warnings.length} parser warning(s): {snapshot.warnings.join('; ')}
        </div>
      )}
    </Shell>
  );
}

/** A first boot builds the database; the window must say so, not sit blank. */
export function LoadingBanner({ progress }: { progress?: string }): React.ReactNode {
  return (
    <div className="banner loading">
      <span className="spinner" aria-hidden />
      <span>{progress ?? 'Reading the save…'}</span>
      <div className="banner-note">
        The first run builds the item database from your install; later runs read one cached file.
      </div>
    </div>
  );
}

/**
 * The layout, without the session — so a story can mount it with a fixture and
 * screenshot the real thing rather than an approximation of it.
 *
 * Three panes at full width: the loadout comparison, the character sheet, and
 * the containers. Below ~1600 the containers drop under the sheet, and below
 * ~1180 everything stacks. The sheet's own width is fixed rather than fluid —
 * a resistance table stretched across half a screen is harder to read across,
 * not easier, and the space it gives up is exactly what buys the third column.
 */
export function Workspace({
  snapshot,
  advice,
  run = null,
  activity,
  history = [],
  adviceError,
  initialTab = 'loadout',
  onRunAdvice,
  onCancelAdvice,
  onNewRun,
}: {
  snapshot: UiSnapshot;
  advice: AdviseEnvelope | null;
  /** The run in flight, if any — the panel's phase label and clock come off it. */
  run?: AdviseRun | null;
  /** What the model has written, live and then afterwards. */
  activity?: RunActivity;
  /** Every stored run for this character, newest first. */
  history?: readonly AdviceRunRef[];
  adviceError?: string;
  /** Which of the two column tabs to open on. Only a story ever sets it. */
  initialTab?: ColumnTab;
  onRunAdvice?: (question?: string) => void;
  onCancelAdvice?: () => void;
  /** Put the open run away and offer a fresh one. Deletes nothing. */
  onNewRun?: () => void;
}): React.ReactNode {
  const [weaponSet, setWeaponSet] = useState<1 | 2 | null>(null);
  const heldSet: 1 | 2 = snapshot.alternateWeaponSetActive ? 2 : 1;
  const running = run !== null;

  /**
   * Loadout and Advice share the column as tabs, and the tab follows the run.
   *
   * Stacked, the advice panel lived below fourteen slot rows — off the bottom of
   * the screen exactly when a run was streaming its reasoning, which is the one
   * moment the panel has something live to show. As tabs each gets the whole
   * column: **a run starting opens Advice** (the transcript is what there is to
   * watch), and **the run finishing goes back to Loadout**, because the result
   * of a run is marks and proposals on the gear, not the table about them.
   *
   * The switch-back yields to the reader: a manual tab change during the run
   * pins the column until the next run starts — being yanked out of the
   * reasoning mid-paragraph is the pinned-scroll mistake in tab form. And a run
   * that *fails* stays on Advice, where the error sentence is; switching away
   * from a failure would hide the only explanation of it.
   */
  const [tab, setTab] = useState<ColumnTab>(initialTab);
  const pinned = useRef(false);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (running && !wasRunning.current) {
      pinned.current = false;
      setTab('advice');
    }
    if (!running && wasRunning.current && !pinned.current && !adviceError) setTab('loadout');
    wasRunning.current = running;
  }, [running, adviceError]);
  // A start that was *refused* never becomes a run, so the effect above never
  // fires — but the refusal is a sentence in the advice panel, and it must not
  // be a sentence on a hidden tab.
  useEffect(() => {
    if (adviceError && !running) setTab('advice');
  }, [adviceError, running]);
  const pick = (next: ColumnTab): void => {
    if (running) pinned.current = true;
    setTab(next);
  };

  // Everything the plan asks the player to touch, marked in the containers for
  // as long as the run stands. Derived from the envelope rather than tracked, so
  // a re-run replaces the marks instead of accumulating them — and derived in
  // one place, so the corner badge, the tab counts and the action tooltip are
  // three views of one reading of the plan.
  const { setActions, setAdvice } = useHighlight();
  const actions = useMemo(() => actionMarks(advice), [advice]);
  const marks = useMemo(() => adviceMarks(advice?.plan), [advice]);
  useEffect(() => setActions(actions), [actions, setActions]);
  useEffect(() => setAdvice(marks), [marks, setAdvice]);

  return (
    <main className="app-body">
      <div className="pane pane-loadout">
        {/* Sticky over the scrolling panel, like the container chrome: deep in
            fourteen slot rows, the way to the other tab must not be a scroll
            back up. */}
        <div className="tab-strip column-tabs">
          {COLUMN_TABS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`tab ${tab === key ? 'selected' : ''}`}
              onClick={() => pick(key)}
            >
              {label}
              {/* The one tab-strip fact that matters from the other tab: a run
                  is alive in there. The dot is the containers' own "something
                  in here" vocabulary. */}
              {key === 'advice' && running && <span className="tab-running" aria-label="run in flight" />}
            </button>
          ))}
        </div>
        {tab === 'loadout' && (
          <LoadoutPanel
            snapshot={snapshot}
            advice={advice}
            weaponSet={weaponSet ?? heldSet}
            onWeaponSet={setWeaponSet}
          />
        )}
        {tab === 'advice' && (
          <AdvicePanel
            snapshot={snapshot}
            advice={advice}
            run={run}
            {...(activity ? { activity } : {})}
            history={history}
            {...(adviceError ? { error: adviceError } : {})}
            {...(onRunAdvice ? { onRun: onRunAdvice } : {})}
            {...(onCancelAdvice ? { onCancel: onCancelAdvice } : {})}
            {...(onNewRun ? { onNewRun } : {})}
          />
        )}
      </div>
      <div className="pane pane-stats">
        <StatsPanel stats={snapshot.stats} advice={advice} />
      </div>
      <div className="pane pane-containers">
        <ContainerPanel snapshot={snapshot} />
      </div>
    </main>
  );
}

/** The two halves of the right-hand column. You act from the loadout; the run lives in Advice. */
export type ColumnTab = 'loadout' | 'advice';

const COLUMN_TABS: readonly (readonly [ColumnTab, string])[] = [
  ['loadout', 'Loadout'],
  ['advice', 'Advice'],
];

/** Providers plus the frame every screen shares. */
export function Shell({ children }: { children: React.ReactNode }): React.ReactNode {
  return (
    <HighlightProvider>
      <TooltipProvider>
        <div className="app">
          {children}
          <footer className="app-footer">
            Item data &amp; icons read from your Grim Dawn install — game data © Crate Entertainment.
          </footer>
        </div>
      </TooltipProvider>
    </HighlightProvider>
  );
}
