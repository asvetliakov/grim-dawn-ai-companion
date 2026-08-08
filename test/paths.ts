/**
 * Locating the live save files.
 *
 * Tests read the user's real saves in place — they are the only fixtures that
 * prove the parser against the actual game version. Nothing here is committed:
 * saves are game-derived data and stay out of the repo.
 */

import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

/** Steam Cloud userdata save directory — override with `GD_SAVE_DIR`. */
export const SAVE_DIR =
  process.env.GD_SAVE_DIR ??
  join(
    homedir(),
    'Library/Application Support/CrossOver/Bottles/Steam/drive_c',
    'Program Files (x86)/Steam/userdata/42909985/219990/remote/save',
  );

export const CHARACTERS = ['_Suchka', '_abcdef'] as const;

export function characterSavePath(name: string): string {
  return join(SAVE_DIR, 'main', name, 'player.gdc');
}

export function haveSaves(): boolean {
  return CHARACTERS.every((c) => existsSync(characterSavePath(c)));
}

export const MISSING_SAVES_MESSAGE =
  `live Grim Dawn saves not found under ${SAVE_DIR} — ` +
  'set GD_SAVE_DIR to a save directory containing main/<character>/player.gdc to run these tests';

/** Git-ignored snapshot copies, so a test can pin a byte-exact fixture. */
const FIXTURE_DIR = join(import.meta.dirname, 'fixtures');

/**
 * Copy a live save into `test/fixtures/` on first use and return that path.
 * The game rewrites saves as you play; snapshotting keeps a test that asserts
 * on specific values from breaking the next time the character is played.
 */
export function snapshotCharacterSave(name: string): string {
  const source = characterSavePath(name);
  const target = join(FIXTURE_DIR, `${name}.gdc`);
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  return target;
}
