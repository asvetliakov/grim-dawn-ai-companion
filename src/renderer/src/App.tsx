import { useEffect, useMemo, useState } from 'react';

import { adviceMarks } from '../../shared/advice-marks.js';
import type { AdviseEnvelope, UiSnapshot } from '../../shared/ipc.js';
import { actionMarks } from './advice.js';
import { AdvicePanel } from './components/AdvicePanel.js';
import { ContainerPanel } from './components/ContainerPanel.js';
import { Header } from './components/Header.js';
import { LoadoutPanel } from './components/LoadoutPanel.js';
import { StatsPanel } from './components/StatsPanel.js';
import { HighlightProvider, useHighlight } from './highlight.js';
import { useSession, type AdviseRun } from './session.js';
import { TooltipProvider } from './tooltip.js';

export function App(): React.ReactNode {
  const session = useSession();
  const { bootstrap, snapshot, advice, run, adviceError, loading, progress, error } = session;

  return (
    <Shell>
      <Header
        {...(bootstrap ? { bootstrap } : {})}
        {...(snapshot ? { snapshot } : {})}
        loading={loading}
        hasAdvice={advice !== undefined}
        runningAdvice={run !== null}
        onCharacter={session.setCharacter}
        onDifficulty={(difficulty) => session.updateSettings({ difficultyOverride: difficulty })}
        onRefresh={session.refresh}
        onRunAdvice={() => session.startAdvice()}
      />

      {error && <div className="banner error">{error}</div>}
      {loading && !snapshot && <LoadingBanner progress={progress} />}

      {snapshot && (
        <Workspace
          snapshot={snapshot}
          advice={advice ?? null}
          run={run}
          {...(adviceError ? { adviceError } : {})}
          onRunAdvice={session.startAdvice}
          onCancelAdvice={session.cancelAdvice}
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
  adviceError,
  onRunAdvice,
  onCancelAdvice,
}: {
  snapshot: UiSnapshot;
  advice: AdviseEnvelope | null;
  /** The run in flight, if any — the panel's phase label and clock come off it. */
  run?: AdviseRun | null;
  adviceError?: string;
  onRunAdvice?: (question?: string) => void;
  onCancelAdvice?: () => void;
}): React.ReactNode {
  const [weaponSet, setWeaponSet] = useState<1 | 2 | null>(null);
  const heldSet: 1 | 2 = snapshot.alternateWeaponSetActive ? 2 : 1;

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
        <LoadoutPanel
          snapshot={snapshot}
          advice={advice}
          weaponSet={weaponSet ?? heldSet}
          onWeaponSet={setWeaponSet}
        />
        <AdvicePanel
          snapshot={snapshot}
          advice={advice}
          run={run}
          {...(adviceError ? { error: adviceError } : {})}
          {...(onRunAdvice ? { onRun: onRunAdvice } : {})}
          {...(onCancelAdvice ? { onCancel: onCancelAdvice } : {})}
        />
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
