/**
 * Watch the save tree and say, in domain terms, what the game just wrote.
 *
 * The point is not "a file changed" — that is one `fs.watch` call — it is
 * **"a file changed and is readable"**. Grim Dawn writes saves event-driven and
 * non-atomically, so a read that races the write sees a torn file; the block
 * checksums catch that immediately, which is exactly the retry design Stage 1
 * built, now driven by a filesystem event instead of a keypress. A watcher that
 * announced the raw event would hand the window a save it cannot parse and turn
 * every autosave into an error banner.
 *
 * So each event is debounced (the game writes several files in a burst), then
 * parsed, retried a few times a second apart, and only then announced — with the
 * parsed save attached, because the consumer would otherwise immediately read the
 * same file a second time and could lose the race the retries just won.
 *
 * **No `chokidar`.** The stage plan called for it; the repo's zero-runtime-
 * dependency rule wins, as it did for `sharp`, `execa`, `react-markdown` and
 * `lucide-react`. `fs.watch(dir, { recursive: true })` is FSEvents on macOS and
 * ReadDirectoryChangesW on Windows — the two platforms this tool runs on — and
 * everything chokidar adds on top of it (globbing, stat polling, atomic-write
 * heuristics) is either unnecessary here or is the debounce-and-parse loop below,
 * which has to exist either way because a `.gdc` is only valid when its checksums
 * say so.
 *
 * Plain Node, zero Electron: the CLI `watch` command drives the same object the
 * main process does, so this is verifiable without a window.
 */

import { readFileSync, readdirSync, statSync, watch as fsWatch } from 'node:fs';
import { join, sep } from 'node:path';

import { parseGdc } from './save/gdc.js';
import { parseFormulasFile, parseReagents, parseTransferStash } from './save/gst.js';
import type { BlockReport, CharacterSave } from './save/types.js';

/** What the watcher saw, once it was sure the file could be read. */
export type WatchEvent =
  | {
      type: 'character-updated';
      character: string;
      /** The file that actually parsed — the save, or a rotation backup. */
      path: string;
      save: CharacterSave;
      /** True when the live save never parsed and this came off `player.gNN`. */
      fromBackup: boolean;
    }
  | { type: 'stash-updated' }
  | { type: 'materials-updated' }
  | { type: 'formulas-updated' }
  /** Every attempt failed, and there was no readable backup either. */
  | { type: 'parse-failed'; character?: string; message: string };

/**
 * Timers, injected.
 *
 * The retry path is entirely made of waiting — "fails twice, then succeeds" is a
 * three-second test against real timers and a synchronous one against these. It
 * is also the seam a test mutates the world through: the file becomes readable
 * *during* an injected `delay`, which is precisely what happens in the game.
 */
export interface WatcherClock {
  /** Run `fn` after `ms`; the returned function cancels it if it has not run. */
  schedule(fn: () => void, ms: number): () => void;
  delay(ms: number): Promise<void>;
}

export const realClock: WatcherClock = {
  schedule(fn, ms) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
};

/**
 * The filesystem half, injected for the same reason: a test should be able to
 * say "the game wrote `main/_Suchka/player.gdc`" without waiting on FSEvents,
 * whose latency is not ours to control and whose coalescing is not ours to
 * predict.
 *
 * `onChange` takes a path **relative to the watched directory**, which is what
 * `fs.watch` reports.
 */
export type WatchBackend = (
  dir: string,
  onChange: (relativePath: string) => void,
  onError: (err: Error) => void,
) => () => void;

export const recursiveWatch: WatchBackend = (dir, onChange, onError) => {
  const watcher = fsWatch(dir, { recursive: true }, (_event, filename) => {
    if (filename) onChange(filename.toString());
  });
  watcher.on('error', onError);
  return () => watcher.close();
};

export interface WatcherOptions {
  saveDir: string;
  onEvent: (event: WatchEvent) => void;
  /** Quiet time after the last write to a path before it is read. */
  debounceMs?: number;
  /** Total parse attempts, including the first. */
  attempts?: number;
  retryDelayMs?: number;
  clock?: WatcherClock;
  watch?: WatchBackend;
  /** Reading a file, injected so a test can make one fail on demand. */
  read?: (path: string) => Buffer;
}

export interface SaveWatcher {
  /** Stop watching; pending debounces and retries are abandoned. */
  close(): void;
  /**
   * Pretend the given save-dir-relative path just changed. The CLI uses it for
   * an initial sanity read, and tests use it as the whole filesystem.
   */
  touch(relativePath: string): void;
}

/** The account-wide files worth re-reading for, and what each one means. */
const ACCOUNT_FILES: Readonly<Record<string, 'stash-updated' | 'materials-updated' | 'formulas-updated'>> = {
  'transfer.gst': 'stash-updated',
  'reagents.gst': 'materials-updated',
  'formulas.gst': 'formulas-updated',
};

/**
 * Each account file's parser, so a `.gst` is validated before it is announced —
 * same rule as the character save, for the same reason. `potions.gst` is not
 * here because nothing downstream reads it.
 */
const ACCOUNT_PARSERS: Readonly<
  Record<string, (buf: Buffer) => { blocks?: BlockReport[]; warnings: string[] }>
> = {
  'transfer.gst': parseTransferStash,
  'reagents.gst': parseReagents,
  'formulas.gst': parseFormulasFile,
};

/** `player.g00`, `player.g01`, … — the game's own rotation backups. */
const BACKUP_NAME = /^player\.g\d+$/i;

/**
 * A torn write does **not** throw, and that is the fact this whole module turns
 * on.
 *
 * Stage 1's rule is that an unknown block must be skipped rather than be fatal,
 * so the parsers degrade instead of failing: a block whose decode goes wrong is
 * resynchronized from its trailing checksum and reported with `checksumOk:
 * false`, and a file that stops mid-block leaves a warning about the bytes it
 * could not use. Both come back as a perfectly ordinary `CharacterSave` — with
 * half the equipment missing. A watcher that only caught exceptions would
 * therefore announce every half-written save as an update, which is precisely
 * the failure the retry loop exists to avoid.
 *
 * On a healthy save every block verifies, *including* the ones we do not decode
 * (15 of 15 on the live fixture), so "any block that did not verify" is a clean
 * signal rather than a heuristic. The warning patterns cover truncation, which
 * has no bad checksum to find because the missing blocks are simply absent.
 */
const TORN_WARNING = /decode failed|exceeds remaining|trailing byte|overran|resync/i;

export function parseProblem(parsed: { blocks?: BlockReport[]; warnings: string[] }): string | undefined {
  const bad = parsed.blocks?.find((b) => !b.checksumOk);
  if (bad) return `block ${bad.id} did not checksum`;
  return parsed.warnings.find((w) => TORN_WARNING.test(w));
}

/**
 * What a changed path is *about*, or nothing.
 *
 * The save tree also holds map data the game rewrites constantly
 * (`levels_world001.map/`), so most events under a recursive watch are noise and
 * are dropped here rather than debounced and then dropped.
 */
function classify(relativePath: string): { character: string } | { account: string } | undefined {
  const parts = relativePath.split(sep).filter((p) => p.length > 0);
  const name = parts[parts.length - 1] ?? '';
  if (parts.length === 3 && parts[0] === 'main' && name === 'player.gdc') return { character: parts[1]! };
  if (parts.length === 1 && name in ACCOUNT_FILES) return { account: name };
  return undefined;
}

/** Rotation backups for a character, newest first. */
export function backupSaves(saveDir: string, character: string): string[] {
  const dir = join(saveDir, 'main', character);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => BACKUP_NAME.test(n))
    .map((n) => join(dir, n))
    .map((path) => ({ path, mtime: mtimeOf(path) }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((f) => f.path);
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export function createSaveWatcher(opts: WatcherOptions): SaveWatcher {
  const {
    saveDir,
    onEvent,
    debounceMs = 2000,
    attempts = 3,
    retryDelayMs = 1000,
    clock = realClock,
    watch = recursiveWatch,
    read = readFileSync,
  } = opts;

  let closed = false;
  /** One debounce per path: a burst of writes to a file is one read of it. */
  const pending = new Map<string, () => void>();

  function schedule(relativePath: string, run: () => void): void {
    pending.get(relativePath)?.();
    const cancel = clock.schedule(() => {
      pending.delete(relativePath);
      if (!closed) void run();
    }, debounceMs);
    pending.set(relativePath, cancel);
  }

  /**
   * Parse with retries. A checksum failure is a torn write, not corruption — the
   * game is still writing — so the only sane response is to wait and read again.
   */
  async function parseWithRetries<T extends { blocks?: BlockReport[]; warnings: string[] }>(
    path: string,
    parse: (buf: Buffer) => T,
  ): Promise<T | Error> {
    let last: Error = new Error(`${path} was never read`);
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (closed) return last;
      try {
        const parsed = parse(read(path));
        const problem = parseProblem(parsed);
        if (!problem) return parsed;
        last = new Error(problem);
      } catch (err) {
        last = err as Error;
      }
      if (attempt < attempts - 1) await clock.delay(retryDelayMs);
    }
    return last;
  }

  async function readCharacter(character: string): Promise<void> {
    const path = join(saveDir, 'main', character, 'player.gdc');
    const result = await parseWithRetries(path, (buf) => parseGdc(buf, { path }));
    if (closed) return;
    if (!(result instanceof Error)) {
      onEvent({ type: 'character-updated', character, path, save: result, fromBackup: false });
      return;
    }

    // Every attempt failed, so this is not a torn write any more. The game's own
    // rotation backups are the last good state it wrote, and showing that beats
    // showing nothing.
    for (const backup of backupSaves(saveDir, character)) {
      try {
        const save = parseGdc(read(backup), { path: backup });
        if (parseProblem(save)) continue;
        onEvent({ type: 'character-updated', character, path: backup, save, fromBackup: true });
        return;
      } catch {
        // Try the next one back: rotation means the newest backup can be as torn
        // as the save itself.
      }
    }
    onEvent({ type: 'parse-failed', character, message: `${path} — ${result.message}` });
  }

  async function readAccountFile(name: string): Promise<void> {
    const path = join(saveDir, name);
    const parse = ACCOUNT_PARSERS[name]!;
    const result = await parseWithRetries(path, parse);
    if (closed) return;
    if (result instanceof Error) {
      onEvent({ type: 'parse-failed', message: `${path} — ${result.message}` });
      return;
    }
    onEvent({ type: ACCOUNT_FILES[name]! });
  }

  function touch(relativePath: string): void {
    if (closed) return;
    const what = classify(relativePath);
    if (!what) return;
    schedule(relativePath, () =>
      'character' in what ? void readCharacter(what.character) : void readAccountFile(what.account),
    );
  }

  const stop = watch(
    saveDir,
    (relativePath) => touch(relativePath),
    (err) => onEvent({ type: 'parse-failed', message: `watching ${saveDir} — ${err.message}` }),
  );

  return {
    touch,
    close() {
      if (closed) return;
      closed = true;
      for (const cancel of pending.values()) cancel();
      pending.clear();
      stop();
    },
  };
}
