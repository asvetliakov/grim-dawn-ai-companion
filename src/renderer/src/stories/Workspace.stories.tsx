/**
 * The window itself, at the size it actually opens.
 *
 * These are the screenshots the UI is judged on: the whole workspace before an
 * advice run and after one, the states that are easy to forget (a character
 * wearing almost nothing, a load that failed, a first boot building the
 * database), and the two narrower widths the layout has to survive.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';

import { LoadingBanner, Shell, Workspace } from '../App.js';
import { Header } from '../components/Header.js';
import { fixtureAdvice, fixtureSnapshot } from '../fixtures.js';
import { IconUrlProvider } from '../icons.js';
import type { Bootstrap, UiSnapshot } from '../../../shared/ipc.js';
import { fixtureIconUrl } from './fixtureIcons.js';

const bootstrap: Bootstrap = {
  settings: { locale: 'en', provider: 'claude-cli', difficultyOverride: 'Ultimate' },
  characters: ['_Fixture', '_Other'],
  active: '_Fixture',
  saveDir: '/fixture/save',
};

function Screen({
  snapshot,
  withAdvice = false,
  loading = false,
  progress,
  error,
}: {
  snapshot?: UiSnapshot;
  withAdvice?: boolean;
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
          hasAdvice={withAdvice}
          onCharacter={() => {}}
          onDifficulty={() => {}}
          onRefresh={() => {}}
          onRunAdvice={() => {}}
        />
        {error && <div className="banner error">{error}</div>}
        {loading && !snapshot && <LoadingBanner {...(progress ? { progress } : {})} />}
        {snapshot && (
          <Workspace snapshot={snapshot} advice={withAdvice ? fixtureAdvice(snapshot) : null} onRunAdvice={() => {}} />
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
