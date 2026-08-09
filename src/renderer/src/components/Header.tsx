/**
 * Character picker, difficulty override, refresh, and where the data comes from.
 *
 * The difficulty control is an *override*, not a display: "Auto" means whatever
 * the save says the character is currently playing, and picking one pins it in
 * settings so the resistance matrix and the advisor both see the same one.
 */

import { useState } from 'react';

import type { Bootstrap, Difficulty, UiSnapshot } from '../../../shared/ipc.js';
import { DIFFICULTY_CHOICES } from '../../../shared/ipc.js';

export function Header({
  bootstrap,
  snapshot,
  loading,
  hasAdvice = false,
  runningAdvice = false,
  onCharacter,
  onDifficulty,
  onRefresh,
  onRunAdvice,
}: {
  bootstrap?: Bootstrap;
  snapshot?: UiSnapshot;
  loading: boolean;
  hasAdvice?: boolean;
  runningAdvice?: boolean;
  onCharacter: (name: string) => void;
  onDifficulty: (difficulty: Difficulty | undefined) => void;
  onRefresh: () => void;
  onRunAdvice?: () => void;
}): React.ReactNode {
  const [showPaths, setShowPaths] = useState(false);
  const characters = bootstrap?.characters ?? [];
  const override = bootstrap?.settings.difficultyOverride ?? '';

  return (
    <header className="app-header">
      <div className="app-title">Grim Dawn Companion</div>

      <label className="field">
        <span>Character</span>
        <select
          value={snapshot?.character ?? bootstrap?.active ?? ''}
          onChange={(e) => onCharacter(e.target.value)}
          disabled={characters.length === 0}
        >
          {characters.length === 0 && <option value="">none found</option>}
          {characters.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Difficulty</span>
        <select
          value={override}
          onChange={(e) => onDifficulty((e.target.value || undefined) as Difficulty | undefined)}
        >
          <option value="">Auto ({snapshot?.difficulty ?? '—'})</option>
          {DIFFICULTY_CHOICES.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>

      <button type="button" className="chrome-button" onClick={onRefresh} disabled={loading}>
        {loading ? 'Reading…' : 'Refresh'}
      </button>

      <div className="header-spacer" />

      {/* The app's one expensive action, where an expensive action belongs.
          It is also in the advice panel, next to what it produces. */}
      <button
        type="button"
        className="chrome-button primary"
        onClick={onRunAdvice}
        disabled={runningAdvice || !onRunAdvice || !snapshot}
        title="Compile the dossier and ask the model — several minutes"
      >
        {runningAdvice ? 'Thinking…' : hasAdvice ? 'Re-run advice' : 'Run advice'}
      </button>

      <button
        type="button"
        className="chrome-button subtle"
        onClick={() => setShowPaths((v) => !v)}
        title="Where the data comes from"
      >
        Paths
      </button>

      {showPaths && bootstrap && (
        <div className="paths-popover">
          <div>
            <b>Game</b> {bootstrap.settings.gameDir ?? 'auto-detected'}
          </div>
          <div>
            <b>Saves</b> {bootstrap.saveDir}
          </div>
          <div>
            <b>Locale</b> {bootstrap.settings.locale}
          </div>
          {snapshot && (
            <div>
              <b>Game version</b> {snapshot.gameVersion}
            </div>
          )}
          {bootstrap.gameDirProblem && <div className="warn">{bootstrap.gameDirProblem}</div>}
          <div className="paths-note">
            Settings live in <code>~/Library/Application Support/gd-companion/settings.json</code>.
          </div>
        </div>
      )}
    </header>
  );
}
