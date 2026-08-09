import { createElement } from 'react';
import type { Preview } from '@storybook/react-vite';

import '../src/renderer/src/styles.css';

/**
 * Storybook's own preview wrapper is height-less by default, which quietly
 * turns every full-screen story into one that cannot scroll — the app's panes
 * are `height: 100%` all the way down and collapse to their content instead.
 * Pinning the root to the viewport is what makes a story behave like the
 * window, scrollbars included.
 *
 * Written with `createElement` rather than JSX so this file needs nothing from
 * the React plugin's transform, which does not reach the config directory.
 */
const preview: Preview = {
  parameters: {
    layout: 'fullscreen',
    controls: { disable: true },
    backgrounds: { disable: true },
  },
  decorators: [
    (Story) =>
      createElement(
        'div',
        { style: { height: '100vh', display: 'flex', flexDirection: 'column' } },
        createElement(Story),
      ),
  ],
};

export default preview;
