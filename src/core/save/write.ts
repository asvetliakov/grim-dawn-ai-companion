/**
 * Writing a character save back to disk — the only place in this tool that does.
 *
 * Two rules, both learned from what the rest of the app already knows about
 * this file. The game writes saves event-driven and non-atomically, and the
 * watcher is live: a partial write would be read as a torn save, retried, and
 * then fall back to a rotation backup, so the window would show the character
 * as they were *before* the edit. Hence temp file plus `rename`, the pattern
 * `db/cache.ts` and `advice-store.ts` already use, with an `fsync` added
 * because this one is the user's character rather than a cache.
 *
 * And the original is kept forever. The doctrine the advice store follows —
 * nothing in this app deletes something that cost the user anything — applies
 * far more here: the game itself cannot undo a mastery removal.
 */

import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { appDataDir } from '../db/cache.js';
import type { SaveTree } from '../paths.js';

/** `2026-08-16T12-30-05-123Z` — a filename, and still sorts chronologically. */
function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * Copy the save somewhere the game cannot reach before touching it.
 *
 * Deliberately *not* beside `player.gdc`: the game keeps its own rotation
 * backups there as `player.gNN`, deleting a character deletes the directory,
 * and the watcher classifies by filename. Under the tool's own data directory a
 * backup is nobody else's business.
 */
export function backupCharacterSave(
  savePath: string,
  character: string,
  tree: SaveTree = 'main',
  now = new Date(),
): string {
  // Custom-game characters get their own subtree: the two namespaces are
  // independent and a name can live in both (this machine has a `_Suchka` in
  // each), so one shared folder would offer the wrong file to restore.
  const dir = join(appDataDir(), 'backups', ...(tree === 'main' ? [] : [tree]), character);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `player-${stamp(now)}.gdc`);
  copyFileSync(savePath, target);
  return target;
}

/**
 * Replace a save file in one step.
 *
 * The temp file has to live in the same directory as its target — `rename` is
 * only atomic within a filesystem — and it is named so the watcher ignores it:
 * `classify` matches `main/<character>/player.gdc` exactly.
 */
export function writeSaveAtomically(savePath: string, bytes: Buffer): void {
  const temp = join(dirname(savePath), `.player.gdc.${process.pid}.tmp`);
  const fd = openSync(temp, 'w');
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, savePath);
  } catch (err) {
    if (existsSync(temp)) unlinkSync(temp);
    throw err;
  }
}

/**
 * Has the file changed since it was read? A save edit is built against exact
 * bytes, so anything else on disk means the game wrote while we were thinking.
 */
export function saveChangedOnDisk(savePath: string, source: Buffer): boolean {
  return !readFileSync(savePath).equals(source);
}
