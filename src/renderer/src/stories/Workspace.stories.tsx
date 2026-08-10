/**
 * The window itself, at the size it actually opens.
 *
 * These are the screenshots the UI is judged on: the whole workspace before an
 * advice run and after one, the states that are easy to forget (a character
 * wearing almost nothing, a load that failed, a first boot building the
 * database), and the two narrower widths the layout has to survive.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';

import { LoadingBanner, Shell, Workspace, type ColumnTab } from '../App.js';
import { Header } from '../components/Header.js';
import { fixtureAdvice, fixtureSnapshot, FIXTURE_THINKING } from '../fixtures.js';
import { IconUrlProvider } from '../icons.js';
import type { AdviseRun, RunActivity } from '../session.js';
import type { AdviceRunRef, AdviseEnvelope, Bootstrap, UiSnapshot } from '../../../shared/ipc.js';
import { fixtureIconUrl } from './fixtureIcons.js';

/**
 * Two stored runs, newest first — what the picker picks between.
 *
 * The second one asked a question, which is what a picker label leads with: two
 * runs on the same save differ by what was asked far more usefully than by two
 * timestamps half an hour apart.
 */
const STORED_RUNS: readonly AdviceRunRef[] = [
  {
    id: '2026-08-09T09-15-00-000Z',
    generatedAt: '2026-08-09T09:15:00.000Z',
    model: 'opus',
    calls: 2,
    costUsd: 4.16,
    verdicts: 6,
    warnings: 0,
    question: 'I am committing to bleeding — do not protect the physical damage.',
  },
  {
    id: '2026-08-08T21-02-00-000Z',
    generatedAt: '2026-08-08T21:02:00.000Z',
    model: 'opus',
    calls: 1,
    costUsd: 3.4,
    verdicts: 6,
    warnings: 2,
  },
];

const bootstrap: Bootstrap = {
  settings: { locale: 'en', provider: 'claude-cli', difficultyOverride: 'Ultimate' },
  characters: ['_Fixture', '_Other'],
  active: '_Fixture',
  saveDir: '/fixture/save',
  gameDir: '/fixture/game/Grim Dawn',
  locales: ['DE', 'EN', 'FR', 'RU'],
};

function Screen({
  snapshot,
  withAdvice = false,
  advice,
  history = [],
  adviceId,
  run,
  activity,
  adviceError,
  initialTab,
  loading = false,
  progress,
  error,
}: {
  snapshot?: UiSnapshot;
  withAdvice?: boolean;
  /** An envelope the story has altered — drift, a second run, a different plan. */
  advice?: AdviseEnvelope;
  /** Stored runs, so the picker has something to pick between. */
  history?: readonly AdviceRunRef[];
  /**
   * Which stored run is open. Separate from `history` on purpose: the window's
   * *landing* state is answers kept and none of them open, which is only
   * expressible if the two can be set independently.
   */
  adviceId?: string;
  /** A run in flight, at the age the story wants to show it at. */
  run?: AdviseRun;
  /** What the model has written so far. */
  activity?: RunActivity;
  adviceError?: string;
  /** Which column tab to open on — a story showing the advice panel says so. */
  initialTab?: ColumnTab;
  loading?: boolean;
  progress?: string;
  error?: string;
}): React.ReactNode {
  return (
    <IconUrlProvider resolve={fixtureIconUrl}>
      <Shell>
        <Header
          bootstrap={bootstrap}
          {...(snapshot ? { snapshot } : {})}
          loading={loading}
          hasAdvice={withAdvice || advice !== undefined}
          runningAdvice={run !== undefined}
          history={history}
          {...(adviceId ? { adviceId } : {})}
          onCharacter={() => {}}
          onDifficulty={() => {}}
          onRefresh={() => {}}
          onRunAdvice={() => {}}
          onSelectAdvice={() => {}}
          onNewRun={() => {}}
          onIncludeStash={() => {}}
          onSettings={() => {}}
        />
        {error && <div className="banner error">{error}</div>}
        {loading && !snapshot && <LoadingBanner {...(progress ? { progress } : {})} />}
        {snapshot && (
          <Workspace
            snapshot={snapshot}
            advice={advice ?? (withAdvice ? fixtureAdvice(snapshot) : null)}
            run={run ?? null}
            {...(activity ? { activity } : {})}
            history={history}
            {...(adviceError ? { adviceError } : {})}
            {...(initialTab ? { initialTab } : {})}
            onRunAdvice={() => {}}
            onCancelAdvice={() => {}}
            onNewRun={() => {}}
          />
        )}
      </Shell>
    </IconUrlProvider>
  );
}

const meta: Meta<typeof Screen> = { title: 'App/Workspace', component: Screen };
export default meta;

type Story = StoryObj<typeof Screen>;

/** What the app looks like on open: everything read, nothing asked yet. */
export const BeforeAdvice: Story = {
  render: () => <Screen snapshot={fixtureSnapshot()} />,
};

/** After a run: proposals in the right-hand column, projections in the sheet. */
export const WithAdvice: Story = {
  render: () => <Screen snapshot={fixtureSnapshot()} withAdvice />,
};

/**
 * The landing state for anyone who has run this before: **answers kept, none of
 * them open**.
 *
 * The window used to reopen the newest answer by itself, and that put a stale
 * plan's marks on the gear before the reader had asked for them — making "is this
 * still about what I am wearing?" the first question of every session rather than
 * one they chose to ask. So the run is a door now, and this is the door: the picker
 * says how many answers are waiting, the panel says they are kept, and the Run
 * button is the other way out of here.
 */
export const AdviceNothingOpen: Story = {
  // On the Advice tab, because the story is about the empty state's own words:
  // how many answers are kept, and where the door to them is.
  render: () => <Screen snapshot={fixtureSnapshot()} history={STORED_RUNS} initialTab="advice" />,
};

/**
 * Four minutes into a run.
 *
 * The state the app spends the most *time* in and the easiest one to get wrong:
 * an eight-minute call with an opaque subprocess at the end of it. What the panel
 * can honestly say is which of the three phases is happening and how long it has
 * been going — the clock is deliberately at a number that looks like a real run
 * rather than at zero, because "0:03" and "4:07" are read completely differently.
 */
export const AdviceRunning: Story = {
  render: () => (
    <Screen
      snapshot={fixtureSnapshot()}
      run={{ runId: 'story', phase: 'asking', startedAt: Date.now() - 247_000, elapsedMs: 247_000 }}
      // What the backend will tell us, when it streams. The phase label says
      // "asking the model" for ten minutes either way; this is the difference
      // between a run you can watch working and one you can only wait out — and
      // the reasoning is worth reading in its own right, being about this build.
      activity={{ kind: 'thinking', text: FIXTURE_THINKING, outputTokens: 21_480 }}
    />
  ),
};

/**
 * A run whose moves have partly been carried out, and one slot that changed for
 * reasons the plan knows nothing about.
 *
 * The distinction the panel exists to draw: **acting on the advice is what makes
 * the loadout differ from it**, so a naive staleness check would call this answer
 * stale as its reward for being followed — and the obvious next step, discarding
 * the stored run on any mismatch, would delete a twelve-minute answer at the
 * moment the user did what it said.
 */
export const AdviceAfterActing: Story = {
  render: () => {
    const snapshot = fixtureSnapshot();
    // Built first, so its `worn` is the loadout as it was *before* any of this —
    // which is what a stored run's record of the loadout actually is.
    const advice = fixtureAdvice(snapshot);
    const bag = snapshot.bags[0]!.items;

    // Belt: the EQUIP has been carried out in full — it names no fits, so the
    // girdle being the worn item is the whole instruction done.
    const belt = advice.verdictRows.find((r) => r.slot === 'Belt')!;
    snapshot.equipment[8] = bag.find((item) => item.docId === belt.nextId) ?? snapshot.equipment[8]!;
    // Hands: the EQUIP is carried out but its `fits` are not — the gauntlets are
    // on with their planned component and augment still to apply. Part-way is a
    // state of its own: equipped-then-fitted must not read as CHANGED, and
    // equipped-but-unfitted must not read as DONE.
    const hands = advice.verdictRows.find((r) => r.slot === 'Hands')!;
    snapshot.equipment[5] = bag.find((item) => item.docId === hands.nextId) ?? snapshot.equipment[5]!;
    // Feet: something the plan never mentioned, so its verdict there is about
    // gear the character is no longer wearing.
    snapshot.equipment[4] = bag[3]!;

    return <Screen snapshot={snapshot} advice={advice} />;
  },
};

/**
 * Two answers already paid for, the newer one open.
 *
 * Runs are kept rather than overwritten because each is minutes and real money:
 * taking a second opinion should not be a decision to destroy the first answer, and
 * nothing in the window deletes one. The header picker shows which is open and
 * always offers the way back out (`New run` is its first entry); the panel shows
 * the open run's date, and no second picker.
 */
export const AdviceHistory: Story = {
  // On the Advice tab: this story is about the panel naming its run and the
  // controls around a stored answer, not about the marks it paints.
  render: () => (
    <Screen
      snapshot={fixtureSnapshot()}
      withAdvice
      history={STORED_RUNS}
      adviceId={STORED_RUNS[0]!.id}
      initialTab="advice"
    />
  ),
};

/** A start that was refused. It has to be a sentence in the panel, not a blank pane. */
export const AdviceFailed: Story = {
  render: () => (
    <Screen
      snapshot={fixtureSnapshot()}
      adviceError="claude CLI not found on PATH. Install it, or set `provider` to another backend in settings.json."
    />
  ),
};

/** The first boot, which builds the item database and takes real time. */
export const FirstBoot: Story = {
  render: () => <Screen loading progress="reading 4 archive(s) from the install" />,
};

/** A fresh character — most slots empty, and the layout must not collapse. */
export const SparseCharacter: Story = {
  render: () => {
    const snapshot = fixtureSnapshot();
    return (
      <Screen
        snapshot={{
          ...snapshot,
          equipment: snapshot.equipment.map((item, i) => (i === 2 || i === 0 ? item : null)),
          weaponSets: [[snapshot.weaponSets[0][0] ?? null, null], [null, null]],
          bags: [{ label: 'Bag', width: 12, height: 8, items: [] }],
          personalStash: [],
          transferStash: [],
          materials: [],
        }}
      />
    );
  },
};

/** The install is missing, so the read failed and the message has to be legible. */
export const LoadFailed: Story = {
  render: () => (
    <Screen
      snapshot={fixtureSnapshot()}
      error="Grim Dawn install not found. Set GD_GAME_DIR (or `gameDir` in settings.json) to the directory containing database/database.arz."
    />
  ),
};
