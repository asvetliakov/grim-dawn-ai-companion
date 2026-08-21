import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * Three builds, one repo.
 *
 * `src/core` and `@grimdawn/core` are bundled into the main process rather than
 * externalized — both are our own code with no native dependencies, which is the
 * whole reason this project hand-wrote its `.arz`/`.arc`/DDS/PNG readers. The
 * renderer never touches any of it: it sees only `src/shared`, which is types
 * and pure functions.
 *
 * The library is a `file:` dependency, so it lives in `node_modules` as a
 * **symlink** to a sibling checkout. `externalizeDepsPlugin` externalizes
 * anything listed in `dependencies`, and an externalized `@grimdawn/core` would
 * be `require()`d at runtime from a symlink that electron-builder's `files`
 * glob does not follow into the asar — the app would start, then die on its
 * first import. Keeping it in `devDependencies` is what makes it bundle; the
 * explicit `exclude` is the belt to that braces, so moving the entry between
 * dependency sections cannot silently break a packaged build.
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
    plugins: [externalizeDepsPlugin({ exclude: ['@grimdawn/core'] })],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@grimdawn/core'] })],
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
