/**
 * Locating the live save files.
 *
 * Tests read the user's real saves in place — they are the only fixtures that
 * prove the parsers against the actual game version. Nothing here is committed:
 * saves are game-derived data and stay out of the repo.
 *
 * Path resolution itself lives in `src/core/paths.ts` (and honours `GD_SAVE_DIR`),
 * so the tests exercise the same lookup the CLI uses rather than a parallel copy.
 */

import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { findGameDir } from '../src/core/db/gamefiles.js';
import { loadGameDb } from '../src/core/db/index.js';
import type { GameDb } from '../src/core/db/types.js';
import {
  characterSavePath as coreCharacterSavePath,
  formulasPath as coreFormulasPath,
  reagentsPath as coreReagentsPath,
  saveDir,
  transferStashPath as coreTransferStashPath,
} from '../src/core/paths.js';

/** Steam Cloud userdata save directory — override with `GD_SAVE_DIR`. */
export const SAVE_DIR = saveDir();

export const CHARACTERS = ['_Suchka', '_abcdef'] as const;

export function characterSavePath(name: string): string {
  return coreCharacterSavePath(name, SAVE_DIR);
}

export const TRANSFER_STASH_PATH = coreTransferStashPath(SAVE_DIR);
export const FORMULAS_PATH = coreFormulasPath(SAVE_DIR);
export const REAGENTS_PATH = coreReagentsPath(SAVE_DIR);

export function haveSaves(): boolean {
  return CHARACTERS.every((c) => existsSync(characterSavePath(c)));
}

export function haveTransferStash(): boolean {
  return existsSync(TRANSFER_STASH_PATH);
}

export function haveFormulas(): boolean {
  return existsSync(FORMULAS_PATH);
}

export function haveReagents(): boolean {
  return existsSync(REAGENTS_PATH);
}

export const MISSING_SAVES_MESSAGE =
  `live Grim Dawn saves not found under ${SAVE_DIR} — ` +
  'set GD_SAVE_DIR to a save directory containing main/<character>/player.gdc to run these tests';

export const MISSING_GST_MESSAGE =
  `live transfer.gst / formulas.gst / reagents.gst not found under ${SAVE_DIR} — ` +
  'set GD_SAVE_DIR to a save directory containing them to run these tests';

/** Git-ignored snapshot copies, so a test can pin a byte-exact fixture. */
const FIXTURE_DIR = join(import.meta.dirname, 'fixtures');

function snapshot(source: string, name: string): string {
  const target = join(FIXTURE_DIR, name);
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  return target;
}

/**
 * Copy a live save into `test/fixtures/` on first use and return that path.
 * The game rewrites saves as you play; snapshotting keeps a test that asserts
 * on specific values from breaking the next time the character is played.
 */
export function snapshotCharacterSave(name: string): string {
  return snapshot(characterSavePath(name), `${name}.gdc`);
}

/** Same idea for the account-wide files — the game rewrites those too. */
export function snapshotSharedSave(path: string): string {
  return snapshot(path, basename(path));
}

// ---------------------------------------------------------------------------
// The game install (Stage 3)
// ---------------------------------------------------------------------------

/**
 * The database tests need Grim Dawn itself, because item identity lives in the
 * game's `.arz` archives and nowhere else. They build the database once into the
 * *real* cache directory rather than a temp one — the build is keyed on the game
 * archives, so reusing the real cache is what keeps a full run at a second
 * instead of re-parsing 26k records for every test file.
 */
export function haveGameInstall(): boolean {
  return findGameDir() !== undefined;
}

export const MISSING_GAME_MESSAGE =
  `Grim Dawn install not found — ` +
  'set GD_GAME_DIR to a directory containing database/database.arz to run these tests';

let dbPromise: Promise<GameDb> | undefined;

/** The shared database, built at most once per test run. */
export function gameDb(): Promise<GameDb> {
  dbPromise ??= loadGameDb();
  return dbPromise;
}
