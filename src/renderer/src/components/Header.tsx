/**
 * Character picker, difficulty override, refresh, and where the data comes from.
 *
 * The difficulty control is an *override*, not a display: "Auto" means whatever
 * the save says the character is currently playing, and picking one pins it in
 * settings so the resistance matrix and the advisor both see the same one.
 */

import type { AdviceRunRef, Bootstrap, Difficulty, UiSnapshot } from '../../../shared/ipc.js';
import { APP_NAME, DIFFICULTY_CHOICES } from '../../../shared/ipc.js';
import { useTooltip } from '../tooltip.js';
import { ExplainedButton } from './ExplainedButton.js';
import { RunPicker } from './RunPicker.js';

export function Header({
  bootstrap,
  snapshot,
  loading,
  hasAdvice = false,
  runningAdvice = false,
  history = [],
  adviceId,
  onCharacter,
  onDifficulty,
  onRefresh,
  onRunAdvice,
  onSelectAdvice,
  onNewRun,
  onIncludeStash,
  onSettings,
}: {
  bootstrap?: Bootstrap;
  snapshot?: UiSnapshot;
  loading: boolean;
  hasAdvice?: boolean;
  runningAdvice?: boolean;
  /** Every stored run for this character, newest first. */
  history?: readonly AdviceRunRef[];
  adviceId?: string;
  onCharacter: (name: string) => void;
  onDifficulty: (difficulty: Difficulty | undefined) => void;
  onRefresh: () => void;
  onRunAdvice?: () => void;
  onSelectAdvice?: (id: string) => void;
  /** Put the open run away, so a new one can be started. Deletes nothing. */
  onNewRun?: () => void;
  /** Persist whether the next run's dossier includes the stashes. */
  onIncludeStash?: (include: boolean) => void;
  /** Open the settings pane — which is also where the paths now live. */
  onSettings?: () => void;
}): React.ReactNode {
  const tooltip = useTooltip();
  const characters = bootstrap?.characters ?? [];
  const override = bootstrap?.settings.difficultyOverride ?? '';
  const includeStash = bootstrap?.settings.includeStashInAdvice ?? true;

  return (
    <header className="app-header">
      <div className="app-title">{APP_NAME}</div>

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

      {/*
        Refresh re-reads the save. Nothing else: not the item database, not a run
        in flight, not the answer on screen.

        Which is worth saying, because all three are the natural worry — and the
        third is the reason this button was the last step of the loop the app is
        for. Since the watcher it is mostly *not* needed, and the note says so
        rather than leaving a reader wondering why nothing happened: the window
        keeps up on its own, and this is the belt-and-braces for the case where a
        file changed in a way the folder never reported.
      */}
      <ExplainedButton
        className="chrome-button"
        label={loading ? 'Reading…' : 'Refresh'}
        disabled={loading}
        onClick={onRefresh}
        note={{
          title: 'Read your save file again',
          body: runningAdvice
            ? 'Picks up whatever you have changed in the game — what you are wearing, what is in your bags and stashes. This happens by itself a couple of seconds after the game saves, so you rarely need it. The question already being asked is not affected: it has everything it needs, and it is answering about the gear it started with.'
            : 'Picks up whatever you have changed in the game — what you are wearing, what is in your bags and stashes. This happens by itself a couple of seconds after the game saves, so you rarely need it. An answer you have open stays open, and the green DONE and amber CHANGED stamps on it are worked out again from what you are wearing now.',
        }}
      />

      <div className="header-spacer" />

      {/*
        The advice controls, up here as well as in the panel — the panel is below
        the loadout and scrolls with it, so on a fourteen-slot character it can be
        entirely off screen while the marks it produced are still on the gear.
        "Which answer is this, and how do I get a new one" is exactly the question
        that arises then.

        One control at a time, and never both. With an answer open there is no Run
        button: a second run costs eight minutes and a few dollars and does not
        replace the answer, so offering it beside one is inviting an accident. `New
        run` puts the answer away — it stays in the picker — and the Run button
        comes back with it.
      */}
      <div className="header-advice">
        {onSelectAdvice && (
          <RunPicker
            history={history}
            {...(adviceId ? { adviceId } : {})}
            onSelect={onSelectAdvice}
            {...(onNewRun ? { onNewRun } : {})}
          />
        )}
        {/*
          What the next run's dossier covers. A stored preference, not a per-run
          flag: it sits with Character and Difficulty because it configures the
          question, not this click. Note before unchecking it: the first live
          run's three best finds were all in the stash.
        */}
        {(!hasAdvice || runningAdvice) && onIncludeStash && (
          <label
            className="include-stash"
            onMouseOver={(e) =>
              tooltip.showNote(
                e.currentTarget,
                'Let the model shop your stashes',
                'Checked, the run considers everything in your personal and transfer stash as candidates alongside your bags. Unchecked, the next run reads only what the character is carrying — cheaper to read, but the model cannot recommend anything you have stored. Your crafting materials and components are always included.',
              )
            }
            onMouseLeave={tooltip.hide}
          >
            <input
              type="checkbox"
              checked={includeStash}
              disabled={runningAdvice}
              onChange={(e) => onIncludeStash(e.target.checked)}
            />
            Stash
          </label>
        )}
        {hasAdvice && onNewRun && (
          <ExplainedButton
            className="chrome-button subtle"
            label="New run"
            disabled={runningAdvice}
            onClick={onNewRun}
            note={{
              title: 'Put this answer away and start fresh',
              body: 'Nothing is deleted and nothing is spent — this answer stays in the list next to the button, and you can open it again whenever you like. Use it when you have changed something the plan did not mention and want to ask again.',
            }}
          />
        )}
        {/* The app's one expensive action, where an expensive action belongs.
            It is also in the advice panel, next to what it produces. */}
        {(!hasAdvice || runningAdvice) && (
          <ExplainedButton
            className="chrome-button primary"
            label={runningAdvice ? 'Thinking…' : 'Run advice'}
            disabled={runningAdvice || !onRunAdvice || !snapshot}
            {...(onRunAdvice ? { onClick: onRunAdvice } : {})}
            note={{
              title: runningAdvice ? 'Already asking' : 'Ask the model what to change',
              body: runningAdvice
                ? 'One question at a time. Cancel it in the Advice panel below if you would rather ask something else — two at once would cost two answers, and the second would be about gear the first has already moved.'
                : 'Everything this character can reach goes to the model in one go — worn gear, both weapon sets, bags, stashes, learned blueprints and what the factions will sell you — and it comes back with a recommendation for every slot. Takes about eight minutes and a few dollars.',
            }}
          />
        )}
      </div>

      {/*
        One door, not two. This used to be `Paths` — a popover that *showed* the
        save and game directories and gave no way to change either, so the only
        answer to "it is reading the wrong install" was to find settings.json and
        edit it by hand. The same facts are now the top section of the settings
        pane, next to the fields that set them.
      */}
      {onSettings && (
        <button type="button" className="chrome-button subtle settings-button" onClick={onSettings}>
          Settings
        </button>
      )}
    </header>
  );
}
