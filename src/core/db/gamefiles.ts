/**
 * Finding the Grim Dawn install and its database archives.
 *
 * The game runs under CrossOver here, so the install lives inside a bottle's
 * `drive_c`; a native Windows/Linux/proton layout is checked too so this stays
 * testable elsewhere. `GD_GAME_DIR` overrides everything, same as `GD_SAVE_DIR`
 * does for saves.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { fingerprint } from './arz.js';

/**
 * Archives in load order. Later archives override earlier ones record-for-record,
 * which is how the expansions patch base-game items — read them in this order and
 * let the last write win. The Crucible (`survivalmode*`) archives are deliberately
 * absent: they add mode-only content that never appears in a campaign save.
 */
const ARCHIVES: readonly { expansion: string; relative: string }[] = [
  { expansion: 'base', relative: 'database/database.arz' },
  { expansion: 'gdx1', relative: 'gdx1/database/GDX1.arz' },
  { expansion: 'gdx2', relative: 'gdx2/database/GDX2.arz' },
  { expansion: 'gdx3', relative: 'gdx3/database/GDX3.arz' },
];

const CROSSOVER_BOTTLES = join(homedir(), 'Library/Application Support/CrossOver/Bottles');
const STEAM_COMMON = 'drive_c/Program Files (x86)/Steam/steamapps/common/Grim Dawn';

/** Every place a Grim Dawn install plausibly sits on this machine. */
function candidateGameDirs(): string[] {
  const candidates: string[] = [];

  // CrossOver bottles, newest-looking first is not worth the effort — any bottle
  // holding the game will do, and there is normally exactly one.
  if (existsSync(CROSSOVER_BOTTLES)) {
    for (const bottle of safeReaddir(CROSSOVER_BOTTLES)) {
      candidates.push(join(CROSSOVER_BOTTLES, bottle, STEAM_COMMON));
    }
  }

  // Native Steam layouts, for running this tool anywhere else.
  candidates.push(
    join(homedir(), 'Library/Application Support/Steam/steamapps/common/Grim Dawn'),
    join(homedir(), '.steam/steam/steamapps/common/Grim Dawn'),
    join(homedir(), '.local/share/Steam/steamapps/common/Grim Dawn'),
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Grim Dawn',
  );

  return candidates;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** A directory counts as an install only if the base archive is actually there. */
function isGameDir(dir: string): boolean {
  return existsSync(join(dir, ARCHIVES[0]!.relative));
}

/**
 * Locate the game install, or return undefined. Undefined is an ordinary
 * outcome (game not installed on this machine) and callers should say so
 * plainly rather than throw a stack trace.
 */
export function findGameDir(): string | undefined {
  const override = process.env.GD_GAME_DIR;
  if (override) return isGameDir(override) ? override : undefined;
  return candidateGameDirs().find(isGameDir);
}

export interface GameArchive {
  expansion: string;
  path: string;
  size: number;
  mtimeMs: number;
}

/** The archives present in `gameDir`, in load order. */
export function gameArchives(gameDir: string): GameArchive[] {
  const found: GameArchive[] = [];
  for (const { expansion, relative } of ARCHIVES) {
    const path = join(gameDir, relative);
    try {
      const st = statSync(path);
      found.push({ expansion, path, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // An expansion the user does not own is simply absent.
    }
  }
  if (found.length === 0) throw new Error(`no .arz archives under ${gameDir} — is this a Grim Dawn install?`);
  return found;
}

/**
 * Cache key for a game build. Size + mtime of every archive: a patch rewrites
 * them, which rotates the key and so re-derives the database (and re-fetches the
 * localization table) exactly once per game version.
 */
export function archivesFingerprint(archives: GameArchive[]): string {
  return fingerprint(archives.map((a) => `${a.expansion}:${a.size}:${Math.round(a.mtimeMs)}`));
}

export const MISSING_GAME_DIR_MESSAGE =
  'Grim Dawn install not found. Set GD_GAME_DIR (or `gameDir` in settings.json) to the ' +
  'directory containing database/database.arz.';
