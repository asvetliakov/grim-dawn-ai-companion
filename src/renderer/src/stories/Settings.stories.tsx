/**
 * The two covering panes.
 *
 * They are the only screens in the app that are *about the app* rather than
 * about the character, and both were built for a specific complaint: "it is
 * reading the wrong install and there is nowhere to say so" (settings — which
 * absorbed the old read-only `Paths` popover), and "what did the model actually
 * see" (the context document, which is also the only place the difficulty
 * override's effect is visible).
 */

import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import { Shell } from '../App.js';
import { ContextViewer } from '../components/ContextViewer.js';
import { SettingsPane } from '../components/SettingsPane.js';
import { fixtureSnapshot } from '../fixtures.js';
import { IconUrlProvider } from '../icons.js';
import type { Bootstrap, ContextDocumentView, DetectedPaths, Settings } from '../../../shared/ipc.js';
import { fixtureIconUrl } from './fixtureIcons.js';

const BOOTSTRAP: Bootstrap = {
  settings: { locale: 'en', provider: 'claude-cli', model: 'opus', effort: 'high', difficultyOverride: 'Ultimate' },
  characters: ['_Fixture', '_Other'],
  active: '_Fixture',
  saveDir: '/fixture/Steam/userdata/1234/219990/remote/save',
  gameDir: '/fixture/Steam/steamapps/common/Grim Dawn',
  locales: ['DE', 'EN', 'ES', 'FR', 'IT', 'PL', 'RU', 'ZH'],
};

/**
 * A machine with **both stores installed** — the case the detection list exists
 * for. One of them is the copy being played and no amount of guessing tells you
 * which, so both are offered and the field stays typeable.
 */
const DETECTED: DetectedPaths = {
  saveDirs: [
    '/fixture/Steam/userdata/1234/219990/remote/save',
    '/fixture/users/player/Documents/My Games/Grim Dawn/save',
  ],
  gameDirs: ['/fixture/Steam/steamapps/common/Grim Dawn', '/fixture/GOG Games/Grim Dawn'],
};

const DOCUMENT: ContextDocumentView = {
  character: '_Fixture',
  difficulty: 'Ultimate',
  tokenEstimate: 36_204,
  stashIncluded: true,
  markdown: [
    '# Grim Dawn character dossier',
    '',
    '## 1. Character',
    '',
    '- Name: Fixture, level 82 Warder',
    '- Difficulty: **Ultimate** (resistance penalty applied below)',
    '',
    '## 2. Resistances',
    '',
    '| Type | Total | Cap | Penalty |',
    '|---|---|---|---|',
    '| Fire Resistance | 74 | 80 | -50 |',
    '| Pierce Resistance | 87 | 80 | -50 |',
    '| Aether Resistance | 154 | 80 | -25 |',
    '| Physical Resistance | 24 | 80 | 0 |',
    '',
    'The difficulty penalty is read from the game data and is **not uniform** —',
    'Ultimate takes 50 off the elemental types and nothing at all off Physical.',
    '',
    '## 3. Damage profile',
    '',
    'Attack speed 177% (2.21/s) against a 200% cap — 19 modifier points of headroom.',
  ].join('\n'),
};

/** Settings edits, held locally so the story behaves like the real pane. */
function LiveSettings({ detected, initial }: { detected?: DetectedPaths; initial?: Settings }): React.ReactNode {
  const [settings, setSettings] = useState<Settings>(initial ?? BOOTSTRAP.settings);
  return (
    <IconUrlProvider resolve={fixtureIconUrl}>
      <Shell>
        <SettingsPane
          bootstrap={{ ...BOOTSTRAP, settings }}
          snapshot={fixtureSnapshot()}
          {...(detected ? { detected } : {})}
          onChange={(patch) => setSettings((prev) => ({ ...prev, ...patch }))}
          onShowContext={() => {}}
          onClose={() => {}}
        />
      </Shell>
    </IconUrlProvider>
  );
}

const meta: Meta = { title: 'App/Settings' };
export default meta;

type Story = StoryObj;

/** Every field, with two installs found. */
export const Pane: Story = {
  render: () => <LiveSettings detected={DETECTED} />,
};

/**
 * The other real backend: codex, on the ChatGPT subscription. The model list
 * and the effort tiers both follow the backend — `ultra` exists here and not
 * on Claude — and the effort notes are the codex ones, which promise nothing
 * the A/B has not measured yet.
 */
export const PaneCodexBackend: Story = {
  render: () => (
    <LiveSettings
      detected={DETECTED}
      initial={{ locale: 'en', provider: 'codex-cli', model: 'gpt-5.6-sol', effort: 'ultra' }}
    />
  ),
};

/**
 * Nothing detected — a machine where the game is somewhere nobody can guess.
 *
 * The fields still work, which is the whole point of them being fields: detection
 * is a convenience, not the mechanism.
 */
export const PaneWithNothingFound: Story = {
  render: () => <LiveSettings />,
};

/**
 * The context document, verbatim.
 *
 * Shown as text and never re-rendered as markdown: the document's exact bytes are
 * the id-stability contract the whole advice-to-item join rests on, so a
 * *rendering* of it would be showing something the model never received.
 */
export const ContextDocument: Story = {
  render: () => (
    <IconUrlProvider resolve={fixtureIconUrl}>
      <Shell>
        <ContextViewer load={() => Promise.resolve(DOCUMENT)} onClose={() => {}} />
      </Shell>
    </IconUrlProvider>
  ),
};
