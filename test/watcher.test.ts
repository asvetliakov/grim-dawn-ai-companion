/**
 * The save watcher.
 *
 * Everything interesting here is *timing* — a torn write that settles a second
 * later, a burst of writes that must read once — so the clock is injected and the
 * filesystem events are fired by hand. What is deliberately **not** faked is the
 * parse: a real `player.gdc` is copied into a temp save tree and really torn, so
 * "a checksum failure means the game is mid-write" is proved against `parseGdc`
 * rather than against a stub that throws on command.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { backupSaves, createSaveWatcher, type WatchBackend, type WatcherClock, type WatchEvent } from '../src/core/watcher.js';
import {
  FORMULAS_PATH,
  MISSING_GST_MESSAGE,
  MISSING_SAVES_MESSAGE,
  REAGENTS_PATH,
  TRANSFER_STASH_PATH,
  haveFormulas,
  haveReagents,
  haveSaves,
  haveTransferStash,
  snapshotCharacterSave,
  snapshotSharedSave,
} from './paths.js';

/**
 * A clock nothing waits on.
 *
 * `schedule` collects its callbacks for `flush()` to run — the debounce, so a
 * burst can be fired synchronously and then read once. `delay` resolves
 * immediately after calling `onDelay`, which is the hook a test tears or repairs
 * the file through: the retry loop's wait is exactly the moment the game finishes
 * writing.
 */
function manualClock(onDelay?: (n: number) => void): WatcherClock & { flush: () => void; delays: number } {
  const scheduled: (() => void)[] = [];
  let delays = 0;
  return {
    schedule(fn) {
      scheduled.push(fn);
      let cancelled = false;
      const index = scheduled.length - 1;
      scheduled[index] = () => {
        if (!cancelled) fn();
      };
      return () => {
        cancelled = true;
      };
    },
    async delay() {
      delays++;
      onDelay?.(delays);
    },
    flush() {
      const due = scheduled.splice(0, scheduled.length);
      for (const fn of due) fn();
    },
    get delays() {
      return delays;
    },
  };
}

/** A filesystem watch that only ever reports what a test tells it to. */
function fakeWatch(): WatchBackend {
  return () => () => {};
}

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

/** A save with one byte of its payload flipped: every block checksum after it fails. */
function torn(good: Buffer): Buffer {
  const bad = Buffer.from(good);
  const at = Math.floor(bad.length / 2);
  bad[at] = bad[at]! ^ 0xff;
  return bad;
}

describe.runIf(haveSaves())('save watcher', () => {
  let good: Buffer;
  beforeAll(() => {
    good = readFileSync(snapshotCharacterSave('_Suchka'));
  });

  it('reads a character save once per burst and reports the parsed save', async () => {
    const dir = tempSaveDir();
    const savePath = join(dir, 'main', '_Suchka', 'player.gdc');
    writeFileSync(savePath, good);

    const events: WatchEvent[] = [];
    const clock = manualClock();
    const watcher = createSaveWatcher({ saveDir: dir, onEvent: (e) => events.push(e), clock, watch: fakeWatch() });

    // The game writes several times in a burst; the debounce is what makes that
    // one read rather than five.
    for (let i = 0; i < 5; i++) watcher.touch(join('main', '_Suchka', 'player.gdc'));
    clock.flush();
    await new Promise((r) => setImmediate(r));

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe('character-updated');
    if (event.type !== 'character-updated') throw new Error('unreachable');
    expect(event.character).toBe('_Suchka');
    expect(event.fromBackup).toBe(false);
    expect(event.save.name).toBeTruthy();
    watcher.close();
  });

  it('retries through a torn write and announces once it parses', async () => {
    const dir = tempSaveDir();
    const savePath = join(dir, 'main', '_Suchka', 'player.gdc');
    writeFileSync(savePath, torn(good));

    const events: WatchEvent[] = [];
    // The file becomes whole *during* the second wait — which is the real
    // sequence: the watcher saw the write start, the game finished it a moment
    // later. Nothing about the first two failures is an error.
    const clock = manualClock((n) => {
      if (n === 2) writeFileSync(savePath, good);
    });
    const watcher = createSaveWatcher({ saveDir: dir, onEvent: (e) => events.push(e), clock, watch: fakeWatch() });

    watcher.touch(join('main', '_Suchka', 'player.gdc'));
    clock.flush();
    await new Promise((r) => setImmediate(r));

    expect(clock.delays).toBe(2);
    expect(events.map((e) => e.type)).toEqual(['character-updated']);
    const event = events[0]!;
    if (event.type !== 'character-updated') throw new Error('unreachable');
    expect(event.fromBackup).toBe(false);
    watcher.close();
  });

  it('falls back to the newest rotation backup when the save never settles', async () => {
    const dir = tempSaveDir();
    const charDir = join(dir, 'main', '_Suchka');
    writeFileSync(join(charDir, 'player.gdc'), torn(good));
    writeFileSync(join(charDir, 'player.g01'), torn(good));
    writeFileSync(join(charDir, 'player.g00'), good);

    const events: WatchEvent[] = [];
    const clock = manualClock();
    const watcher = createSaveWatcher({ saveDir: dir, onEvent: (e) => events.push(e), clock, watch: fakeWatch() });

    watcher.touch(join('main', '_Suchka', 'player.gdc'));
    clock.flush();
    await new Promise((r) => setImmediate(r));

    expect(events).toHaveLength(1);
    const event = events[0]!;
    if (event.type !== 'character-updated') throw new Error(`expected a character update, got ${event.type}`);
    // `player.g01` is newer by mtime and is *also* torn, so the fallback has to
    // keep walking back rather than give up on the first backup it finds.
    expect(event.fromBackup).toBe(true);
    expect(event.path.endsWith('player.g00')).toBe(true);
    watcher.close();
  });

  it('reports a parse failure when there is no readable backup either', async () => {
    const dir = tempSaveDir();
    writeFileSync(join(dir, 'main', '_Suchka', 'player.gdc'), torn(good));

    const events: WatchEvent[] = [];
    const clock = manualClock();
    const watcher = createSaveWatcher({ saveDir: dir, onEvent: (e) => events.push(e), clock, watch: fakeWatch() });

    watcher.touch(join('main', '_Suchka', 'player.gdc'));
    clock.flush();
    await new Promise((r) => setImmediate(r));

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('parse-failed');
    watcher.close();
  });

  it('ignores everything in the tree that is not a save', () => {
    const dir = tempSaveDir();
    const events: WatchEvent[] = [];
    const clock = manualClock();
    const watcher = createSaveWatcher({ saveDir: dir, onEvent: (e) => events.push(e), clock, watch: fakeWatch() });

    // The map data the game rewrites constantly, the cosmetic store nothing
    // reads, and a rotation backup — under a recursive watch these are most of
    // the traffic, and none of them is a reason to re-read anything.
    watcher.touch(join('main', '_Suchka', 'levels_world001.map', 'map.map'));
    watcher.touch('transmutes.gst');
    watcher.touch('playmenu.cpn');
    watcher.touch(join('main', '_Suchka', 'player.g00'));
    clock.flush();

    expect(events).toEqual([]);
    watcher.close();
  });

  it('lists rotation backups newest first, and nothing when there are none', () => {
    const dir = tempSaveDir();
    const charDir = join(dir, 'main', '_Suchka');
    expect(backupSaves(dir, '_Suchka')).toEqual([]);
    expect(backupSaves(dir, 'nobody')).toEqual([]);
    writeFileSync(join(charDir, 'player.g00'), 'a');
    writeFileSync(join(charDir, 'player.g01'), 'b');
    expect(backupSaves(dir, '_Suchka').map((p) => p.slice(charDir.length + 1))).toEqual([
      'player.g01',
      'player.g00',
    ]);
  });
});

describe.runIf(haveTransferStash() && haveFormulas() && haveReagents())('account files', () => {
  it('names what changed, and validates it before saying so', async () => {
    const dir = tempSaveDir();
    cpSync(snapshotSharedSave(TRANSFER_STASH_PATH), join(dir, 'transfer.gst'));
    cpSync(snapshotSharedSave(REAGENTS_PATH), join(dir, 'reagents.gst'));
    cpSync(snapshotSharedSave(FORMULAS_PATH), join(dir, 'formulas.gst'));

    const events: WatchEvent[] = [];
    const clock = manualClock();
    const watcher = createSaveWatcher({ saveDir: dir, onEvent: (e) => events.push(e), clock, watch: fakeWatch() });

    watcher.touch('transfer.gst');
    watcher.touch('reagents.gst');
    watcher.touch('formulas.gst');
    clock.flush();
    await new Promise((r) => setImmediate(r));

    expect(events.map((e) => e.type).sort()).toEqual(['formulas-updated', 'materials-updated', 'stash-updated']);

    // A truncated stash is the same torn write in a different file, and it must
    // not be announced as an update.
    const bad: WatchEvent[] = [];
    writeFileSync(join(dir, 'transfer.gst'), readFileSync(join(dir, 'transfer.gst')).subarray(0, 64));
    const clock2 = manualClock();
    const watcher2 = createSaveWatcher({ saveDir: dir, onEvent: (e) => bad.push(e), clock: clock2, watch: fakeWatch() });
    watcher2.touch('transfer.gst');
    clock2.flush();
    await new Promise((r) => setImmediate(r));
    expect(bad.map((e) => e.type)).toEqual(['parse-failed']);

    watcher.close();
    watcher2.close();
  });
});

/**
 * The main process's half.
 *
 * `SessionState` imports nothing from Electron — the same property that makes the
 * advise run manager testable — so "does changing the save directory restart the
 * watcher" is an ordinary test rather than something only a human clicking around
 * can answer. Real timers here, deliberately: this is about the wiring, and the
 * debounce it waits out is the real one.
 */
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

describe('save watcher without saves', () => {
  it.runIf(!haveSaves())(MISSING_SAVES_MESSAGE, () => {});
  it.runIf(!haveTransferStash())(MISSING_GST_MESSAGE, () => {});
});
