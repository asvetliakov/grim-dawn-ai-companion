/**
 * Settings — the real `Settings` schema, edited in place.
 *
 * Two rules run through it. **Every field writes the same settings file the CLI
 * reads**, so a preference set here and a run started from a terminal cannot
 * disagree; and **a path is typed or picked, never only guessed**. Detection is
 * good on the machines it knows (Steam under CrossOver, GOG under `GOG Games`,
 * a native Windows install) and useless on the ones it does not, so the found
 * paths are offered as a list beside a text field that always accepts an
 * arbitrary one.
 *
 * Text fields commit on blur or Enter rather than per keystroke: `gameDir` and
 * `locale` each drop the item database, and rebuilding it once per character
 * typed into a path is half a minute of work per letter.
 */

import { useEffect, useState } from 'react';

import type { Bootstrap, DetectedPaths, Difficulty, Settings, UiSnapshot } from '../../../shared/ipc.js';
import { DIFFICULTY_CHOICES } from '../../../shared/ipc.js';
import { Modal } from './Modal.js';

/**
 * The effort tiers, each with a sentence for the person choosing. Medium is the
 * default and says so: an A/B on a live save had it produce the same moves as
 * high, cap every resistance sooner, and finish two minutes faster — high's
 * extra thinking went into a maximum-damage line that left a resistance under
 * cap. The notes state what was measured and claim nothing about the
 * unmeasured tiers.
 */
const EFFORTS: readonly { id: string; label: string; note: string }[] = [
  { id: 'low', label: 'low', note: 'Fastest and cheapest, untested for this tool — a quick opinion, not a plan to act on blind.' },
  {
    id: 'medium',
    label: 'medium (recommended)',
    note: 'Good and fast enough: side by side with high it made the same moves, capped every resistance sooner, and finished about two minutes faster. The mechanical checks catch the thoroughness slips lower effort used to risk.',
  },
  {
    id: 'high',
    label: 'high',
    note: 'Thinks noticeably longer for a slightly more aggressive plan — in the side-by-side it kept ~3% more damage by tolerating a resistance under cap for two levels.',
  },
  { id: 'xhigh', label: 'xhigh', note: 'Longer still, untested for this tool. Expect several extra minutes per answer.' },
  { id: 'max', label: 'max', note: 'The slowest and most expensive tier, untested for this tool.' },
];

/**
 * The backends, and what each will answer to.
 *
 * A pair of selects rather than two text fields, because the two are not
 * independent: `opus` means something to the Claude CLI and nothing to a future
 * OpenAI backend, and a model name typed for the wrong backend fails eight
 * minutes into a run rather than at the moment it was typed. The ids are the
 * registry's own (`src/core/ai/provider.ts`); only the labels are for people.
 *
 * `models` is empty where the backend does not take one — the mock answers from
 * a fixture, and the OpenAI provider is a registered stub whose `available()` is
 * false. An empty list disables the model control and says so.
 */
const BACKENDS: readonly {
  id: string;
  label: string;
  note: string;
  models: readonly { id: string; label: string }[];
}[] = [
  {
    id: 'claude-cli',
    label: 'Claude Code',
    note: 'Runs the `claude` command already on this machine and bills through the subscription it is signed into.',
    // Opus is what the advice quality was measured on; sonnet is untested here.
    models: [
      { id: 'opus', label: 'opus (recommended)' },
      { id: 'sonnet', label: 'sonnet' },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    note: 'Registered but not implemented — a run started on it explains itself and stops.',
    models: [],
  },
  {
    id: 'mock',
    label: 'Mock (no model, no cost)',
    note: 'Answers instantly from a fixture. What the app’s own checks run against.',
    models: [],
  },
];

export function SettingsPane({
  bootstrap,
  snapshot,
  detected,
  onChange,
  onShowContext,
  onClose,
}: {
  bootstrap?: Bootstrap;
  snapshot?: UiSnapshot;
  /** What the main process found on this machine; undefined until it answers. */
  detected?: DetectedPaths;
  onChange: (patch: Partial<Settings>) => void;
  onShowContext: () => void;
  onClose: () => void;
}): React.ReactNode {
  const settings = bootstrap?.settings;
  const providerId = settings?.provider ?? 'claude-cli';
  const backend = BACKENDS.find((b) => b.id === providerId) ?? {
    id: providerId,
    label: providerId,
    note: 'A backend set by hand in settings.json.',
    models: [] as readonly { id: string; label: string }[],
  };

  return (
    <Modal title="Settings" subtitle="Written to settings.json — the CLI reads the same file" onClose={onClose}>
      <section className="settings-section">
        <h3>Where the data comes from</h3>

        <PathField
          label="Saves"
          value={settings?.saveDir ?? ''}
          placeholder={bootstrap?.saveDir ?? ''}
          hint="The folder holding main/<character>/ and the shared .gst files. Blank means the tool looks for it — Steam Cloud's userdata folder first, then My Games/Grim Dawn/save, which is where GOG keeps them."
          options={detected?.saveDirs ?? []}
          onCommit={(saveDir) => onChange({ saveDir: saveDir || undefined })}
        />

        <PathField
          label="Game install"
          value={settings?.gameDir ?? ''}
          placeholder={bootstrap?.gameDir ?? 'not found'}
          hint="The folder containing database/database.arz. This is the item database — names, stats and icons all come out of it, and the tool cannot run without one. Changing it rebuilds the database."
          options={detected?.gameDirs ?? []}
          onCommit={(gameDir) => onChange({ gameDir: gameDir || undefined })}
        />

        {bootstrap?.gameDirProblem && <p className="settings-warn">{bootstrap.gameDirProblem}</p>}

        <dl className="settings-facts">
          <dt>Reading saves from</dt>
          <dd>{bootstrap?.saveDir ?? '—'}</dd>
          <dt>Game version</dt>
          <dd>{snapshot?.gameVersion ?? '—'}</dd>
          <dt>Settings file</dt>
          <dd>
            <code>~/Library/Application Support/gd-ai-companion/settings.json</code>
          </dd>
        </dl>
      </section>

      <section className="settings-section">
        <h3>Language</h3>
        <label className="settings-row">
          <span className="settings-label">Item and skill names</span>
          <select
            value={settings?.locale ?? 'en'}
            onChange={(e) => onChange({ locale: e.target.value })}
            disabled={(bootstrap?.locales.length ?? 0) === 0}
          >
            {(bootstrap?.locales.length ? bootstrap.locales : [(settings?.locale ?? 'en').toUpperCase()]).map(
              (code) => (
                <option key={code} value={code.toLowerCase()}>
                  {code}
                </option>
              ),
            )}
          </select>
        </label>
        <p className="settings-hint">
          Only the languages your install actually ships a text archive for. Changing it rebuilds the item
          database in that language; icons are shared and are not rebuilt.
        </p>
      </section>

      <section className="settings-section">
        <h3>Difficulty</h3>
        <label className="settings-row">
          <span className="settings-label">Work the numbers out for</span>
          <select
            value={settings?.difficultyOverride ?? ''}
            onChange={(e) =>
              onChange({ difficultyOverride: (e.target.value || undefined) as Difficulty | undefined })
            }
          >
            <option value="">Whatever the save says ({snapshot?.difficulty ?? '—'})</option>
            {DIFFICULTY_CHOICES.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <p className="settings-hint">
          The same control as the one in the header — resistance penalties differ per difficulty, so this
          changes the sheet and everything the model is told. See it for yourself in the context document
          below.
        </p>
      </section>

      <section className="settings-section">
        <h3>Advice</h3>
        <label className="settings-row">
          <span className="settings-label">Backend</span>
          <select
            value={backend.id}
            // A model belongs to a backend, so switching backend drops it rather
            // than carrying `opus` somewhere it means nothing.
            onChange={(e) => onChange({ provider: e.target.value, model: undefined })}
          >
            {BACKENDS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
            {/* A provider pinned by hand in settings.json still shows up as
                itself rather than silently reading as the first entry. */}
            {!BACKENDS.some((b) => b.id === backend.id) && <option value={backend.id}>{backend.id}</option>}
          </select>
        </label>
        <p className="settings-hint">{backend.note}</p>
        <label className="settings-row">
          <span className="settings-label">Model</span>
          <select
            value={settings?.model ?? ''}
            disabled={backend.models.length === 0}
            onChange={(e) => onChange({ model: e.target.value || undefined })}
          >
            {backend.models.length === 0 ? (
              <option value="">not applicable</option>
            ) : (
              <>
                <option value="">Default ({backend.models[0]!.id})</option>
                {backend.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </>
            )}
          </select>
        </label>
        <label className="settings-row">
          <span className="settings-label">Reasoning effort</span>
          <select
            value={settings?.effort ?? ''}
            onChange={(e) => onChange({ effort: (e.target.value || undefined) as Settings['effort'] })}
          >
            <option value="">Default (medium)</option>
            {EFFORTS.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
        </label>
        <p className="settings-hint">
          {(EFFORTS.find((e) => e.id === (settings?.effort ?? 'medium')) ?? EFFORTS[1]!).note}
        </p>
        <label className="settings-row">
          <span className="settings-label">Give up after</span>
          <input
            type="number"
            min={60}
            step={60}
            placeholder="1200"
            value={settings?.advisorTimeoutSeconds ?? ''}
            onChange={(e) =>
              onChange({ advisorTimeoutSeconds: e.target.value ? Number(e.target.value) : undefined })
            }
          />
          <span className="settings-unit">seconds</span>
        </label>
        <p className="settings-hint">
          A real answer takes about nine minutes, and one that needs a correction round can take a few more.
          The default of twenty minutes is there to stop a wedged run going forever, not to hurry a working
          one along.
        </p>
        <p className="settings-actions">
          <button type="button" className="chrome-button subtle" onClick={onShowContext}>
            View context doc
          </button>
          <span className="settings-hint">Everything the model is sent, exactly as it is sent.</span>
        </p>
      </section>

      <section className="settings-section">
        <h3>Window</h3>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={settings?.alwaysOnTop ?? false}
            onChange={(e) => onChange({ alwaysOnTop: e.target.checked })}
          />
          Keep this window above the game
        </label>
        <p className="settings-hint">
          Its size and position are remembered on their own, and come back where you left them.
        </p>
      </section>
    </Modal>
  );
}

/**
 * A path you can type, with the ones we found underneath it.
 *
 * Held in local state until blur or Enter — see the note at the top of the file:
 * committing per keystroke would rebuild the item database once per character.
 * `value` re-seeds it when the settings change under us (picking a detected path
 * is exactly that).
 */
function PathField({
  label,
  value,
  placeholder,
  hint,
  options,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder: string;
  hint: string;
  options: readonly string[];
  onCommit: (value: string) => void;
}): React.ReactNode {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <div className="settings-path">
      <label className="settings-row">
        <span className="settings-label">{label}</span>
        <input
          type="text"
          className="settings-path-input"
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => draft !== value && onCommit(draft.trim())}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setDraft(value);
          }}
        />
        {value && (
          <button type="button" className="chrome-button subtle" onClick={() => onCommit('')}>
            Auto
          </button>
        )}
      </label>
      <p className="settings-hint">{hint}</p>
      {options.length > 0 && (
        <ul className="settings-found">
          {options.map((option) => (
            <li key={option}>
              <button
                type="button"
                className={`settings-found-path ${option === (value || placeholder) ? 'current' : ''}`}
                onClick={() => onCommit(option)}
              >
                {option}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
