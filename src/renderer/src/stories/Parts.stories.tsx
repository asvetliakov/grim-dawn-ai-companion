/**
 * The pieces on their own, so a change to one can be judged without reading a
 * whole screenshot of the window.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';

import { AdvicePanel } from '../components/AdvicePanel.js';
import { ContainerPanel } from '../components/ContainerPanel.js';
import { ItemTooltip, SocketableTooltip } from '../components/ItemTooltip.js';
import { LoadoutPanel } from '../components/LoadoutPanel.js';
import { StatsPanel } from '../components/StatsPanel.js';
import { HOSTILE_ANSWER, fixtureAdvice, fixtureSnapshot } from '../fixtures.js';
import { HighlightProvider } from '../highlight.js';
import { IconUrlProvider } from '../icons.js';
import { TooltipProvider } from '../tooltip.js';
import { fixtureIconUrl } from './fixtureIcons.js';

function Frame({ children, width = 900 }: { children: React.ReactNode; width?: number }): React.ReactNode {
  return (
    <IconUrlProvider resolve={fixtureIconUrl}>
      <HighlightProvider>
        <TooltipProvider>
          <div style={{ padding: 16, width, maxWidth: '100%' }}>{children}</div>
        </TooltipProvider>
      </HighlightProvider>
    </IconUrlProvider>
  );
}

const meta: Meta = { title: 'Parts' };
export default meta;

export const LoadoutLocked: StoryObj = {
  name: 'Loadout — no advice yet',
  render: () => {
    const snapshot = fixtureSnapshot();
    return (
      <Frame>
        <LoadoutPanel snapshot={snapshot} advice={null} weaponSet={1} onWeaponSet={() => {}} />
      </Frame>
    );
  },
};

export const LoadoutWithAdvice: StoryObj = {
  name: 'Loadout — with proposals',
  render: () => {
    const snapshot = fixtureSnapshot();
    return (
      <Frame>
        <LoadoutPanel snapshot={snapshot} advice={fixtureAdvice(snapshot)} weaponSet={1} onWeaponSet={() => {}} />
      </Frame>
    );
  },
};

export const Advice: StoryObj = {
  name: 'Advice summary',
  render: () => {
    const snapshot = fixtureSnapshot();
    return (
      <Frame>
        <AdvicePanel snapshot={snapshot} advice={fixtureAdvice(snapshot)} onRun={() => {}} />
      </Frame>
    );
  },
};

export const Stats: StoryObj = {
  name: 'Stats — plain',
  render: () => (
    <Frame width={520}>
      <StatsPanel stats={fixtureSnapshot().stats} advice={null} />
    </Frame>
  ),
};

export const StatsProjected: StoryObj = {
  name: 'Stats — with projection',
  render: () => {
    const snapshot = fixtureSnapshot();
    return (
      <Frame width={620}>
        <StatsPanel stats={snapshot.stats} advice={fixtureAdvice(snapshot)} />
      </Frame>
    );
  },
};

export const Containers: StoryObj = {
  name: 'Containers',
  render: () => (
    <Frame width={760}>
      <ContainerPanel snapshot={fixtureSnapshot()} />
    </Frame>
  ),
};

export const Tooltip: StoryObj = {
  name: 'Item tooltip',
  render: () => {
    const snapshot = fixtureSnapshot();
    const item = snapshot.equipment[6]!;
    return (
      <Frame width={520}>
        <ItemTooltip item={item} />
      </Frame>
    );
  },
};

/** Requirements the character cannot meet, and every damage type coloured. */
export const TooltipUnmet: StoryObj = {
  name: 'Item tooltip — cannot equip',
  render: () => {
    const snapshot = fixtureSnapshot();
    const item = snapshot.bags[0]!.items[0]!;
    return (
      <Frame width={520}>
        <ItemTooltip item={item} />
      </Frame>
    );
  },
};

/** A component hovered on its own, in the loadout or the materials list. */
export const SocketTooltip: StoryObj = {
  name: 'Socketable tooltip',
  render: () => {
    const snapshot = fixtureSnapshot();
    const part = snapshot.equipment[2]!.tooltip.component!;
    return (
      <Frame width={420}>
        <SocketableTooltip label="Component" part={part} />
      </Frame>
    );
  },
};

export const Materials: StoryObj = {
  name: 'Materials list',
  render: () => (
    <Frame width={560}>
      <ContainerPanel snapshot={fixtureSnapshot()} initialTab="materials" />
    </Frame>
  ),
};

/**
 * The three shapes a socket move comes in, beside a plain item swap.
 *
 * Four of the seven verdicts keep the item and change what it carries, and each
 * costs something different: an empty socket is free, a re-augment throws the
 * old augment away, and an extraction destroys the item it comes out of. The
 * fourth row is an ordinary EQUIP whose *new* item arrives with a component and
 * an augment already in it — the case that is easy to forget exists.
 */
export const SocketProposals: StoryObj = {
  name: 'Loadout — component & augment moves',
  render: () => {
    const snapshot = fixtureSnapshot();
    return (
      <Frame>
        <LoadoutPanel snapshot={snapshot} advice={fixtureAdvice(snapshot)} weaponSet={1} onWeaponSet={() => {}} />
      </Frame>
    );
  },
};

/** The model's own prose, which is the human product of a run. */
export const Answer: StoryObj = {
  name: 'Advice — full answer',
  render: () => {
    const snapshot = fixtureSnapshot();
    return (
      <Frame>
        <AdvicePanel snapshot={snapshot} advice={fixtureAdvice(snapshot)} onRun={() => {}} />
      </Frame>
    );
  },
  play: async ({ canvasElement }) => {
    const tabs = canvasElement.querySelectorAll<HTMLButtonElement>('.advice-tabs .tab');
    tabs[1]?.click();
  },
};

/**
 * The answer the layout has to survive rather than the one it flatters.
 *
 * A real answer is model output this window has no control over. Each hostile
 * shape has its own escape hatch — a wide table scrolls inside itself, a fenced
 * block scrolls inside itself, prose with no spaces in it breaks anywhere — and
 * none of them may push the panel sideways, because the pane clips rather than
 * scrolls and that overflow would be silent.
 */
export const AnswerHostile: StoryObj = {
  name: 'Advice — an answer that does not fit',
  render: () => {
    const snapshot = fixtureSnapshot();
    const advice = { ...fixtureAdvice(snapshot), answer: HOSTILE_ANSWER };
    return (
      <Frame>
        <AdvicePanel snapshot={snapshot} advice={advice} onRun={() => {}} />
      </Frame>
    );
  },
  play: async ({ canvasElement }) => {
    const tabs = canvasElement.querySelectorAll<HTMLButtonElement>('.advice-tabs .tab');
    tabs[1]?.click();
  },
};
