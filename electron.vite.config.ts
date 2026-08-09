import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * Three builds, one repo.
 *
 * `src/core` is bundled into the main process rather than externalized — it is
 * our own code and has no native dependencies, which is the whole reason this
 * project hand-wrote its `.arz`/`.arc`/DDS/PNG readers. The renderer never
 * touches any of it: it sees only `src/shared`, which is types and pure
 * functions.
 *
 * Both the main process and the preload are emitted as CommonJS, and `.cjs` at
 * that, because this package is `"type": "module"`. Two independent reasons:
 * Electron refuses an ESM preload unless `sandbox: false`, and Node's CJS
 * export detection cannot see named exports through Electron's own module shim
 * — an ESM main dies on `import { BrowserWindow } from 'electron'` before it
 * runs a line. The sandbox and a main process that starts are both worth more
 * than the module syntax.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') },
    },
    plugins: [react()],
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
  },
});
