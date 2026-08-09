import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StorybookConfig } from '@storybook/react-vite';

/**
 * Storybook renders the window's UI in a plain browser, which is how it gets
 * developed and screenshotted without launching Electron. Nothing here touches
 * `src/main` or `src/core` — the components take DTOs, and the stories hand
 * them invented ones.
 */
const here = dirname(fileURLToPath(import.meta.url));

const config: StorybookConfig = {
  stories: ['../src/renderer/src/**/*.stories.tsx'],
  framework: { name: '@storybook/react-vite', options: {} },
  viteFinal: async (cfg) => ({
    ...cfg,
    resolve: { ...cfg.resolve, alias: { '@shared': resolve(here, '../src/shared') } },
  }),
};

export default config;
