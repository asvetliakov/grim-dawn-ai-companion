/**
 * The main process's half of watching.
 *
 * The watcher itself lives in `@grimdawn/core` and is tested there. What is left
 * here is the wiring: `SessionState` imports nothing from Electron — the same
 * property that makes the advise run manager testable — so "does changing the
 * save directory restart the watcher" is an ordinary test rather than something
 * only a human clicking around can answer. Real timers, deliberately: this is
 * about the wiring, and the debounce it waits out is the real one.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { MISSING_SAVES_MESSAGE, haveSaves, snapshotCharacterSave } from './paths.js';

const temps: string[] = [];
function tempSaveDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gd-watch-'));
  temps.push(dir);
  mkdirSync(join(dir, 'main', '_Suchka'), { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0, temps.length)) rmSync(dir, { recursive: true, force: true });
});

describe.runIf(haveSaves())('the session state, watching', () => {
  it('follows the save directory when it moves', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gd-state-'));
    temps.push(dataDir);
    const previous = process.env['GD_DATA_DIR'];
    process.env['GD_DATA_DIR'] = dataDir;
    const { SessionState } = await import('../src/main/state.js');

    const first = tempSaveDir();
    const second = tempSaveDir();
    const good = readFileSync(snapshotCharacterSave('_Suchka'));
    writeFileSync(join(first, 'main', '_Suchka', 'player.gdc'), good);
    writeFileSync(join(second, 'main', '_Suchka', 'player.gdc'), good);

    const pushes: string[] = [];
    const state = new SessionState((event) => pushes.push(event.type));
    try {
      await state.updateSettings({ saveDir: first });
      pushes.length = 0;
      state.startWatching();

      // Touching a save under the watched tree invalidates the snapshot.
      writeFileSync(join(first, 'main', '_Suchka', 'player.gdc'), good);
      expect(await settles(pushes, 'snapshot-invalidated')).toBe(true);

      // Moving the setting moves the watch — and, crucially, *stops* the old one.
      // A watcher left on the previous tree would keep invalidating the window
      // over a directory nothing reads any more.
      await state.updateSettings({ saveDir: second });
      pushes.length = 0;
      writeFileSync(join(second, 'main', '_Suchka', 'player.gdc'), good);
      expect(await settles(pushes, 'snapshot-invalidated')).toBe(true);

      pushes.length = 0;
      writeFileSync(join(first, 'main', '_Suchka', 'player.gdc'), good);
      await new Promise((r) => setTimeout(r, 3500));
      expect(pushes).toEqual([]);
    } finally {
      state.dispose();
      if (previous === undefined) delete process.env['GD_DATA_DIR'];
      else process.env['GD_DATA_DIR'] = previous;
    }
  }, 20_000);
});

/** Wait for a push of the given type — the debounce is 2 s, so this is not instant. */
async function settles(pushes: string[], type: string, timeoutMs = 8000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (pushes.includes(type)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

describe('the session state without saves', () => {
  it.runIf(!haveSaves())(MISSING_SAVES_MESSAGE, () => {});
});
