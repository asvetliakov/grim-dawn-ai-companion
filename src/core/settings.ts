/**
 * Persistent settings: `~/Library/Application Support/gd-ai-companion/settings.json`.
 *
 * Every field has a working default, and the two path fields auto-detect, so the
 * file is optional — the tool runs correctly on this machine before it has ever
 * been written. Values are zod-validated on read: a hand-edited settings file
 * with a typo should say what is wrong, not produce mysterious behaviour later.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { appDataDir, ensureDir } from './db/cache.js';
import { findGameDir } from './db/gamefiles.js';
import { saveDir as detectedSaveDir, type SaveTree } from './paths.js';
import { documentRoots, safeReaddir, steamRoots, STEAM_APP_ID } from './platform.js';
import { settingsSchema, type ResolvedSettings, type Settings } from './settings-schema.js';

export { settingsSchema } from './settings-schema.js';
export type { Settings, ResolvedSettings } from './settings-schema.js';

export function settingsPath(): string {
  return join(appDataDir(), 'settings.json');
}

/**
 * Read settings, or defaults when the file is absent. A malformed file throws
 * with the offending field named — silently falling back to defaults would hide
 * the user's intent.
 */
export function loadSettings(): Settings {
  const path = settingsPath();
  if (!existsSync(path)) return settingsSchema.parse({});

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path} is not valid JSON — ${(err as Error).message}`);
  }

  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`${path} has invalid settings — ${issues}`);
  }
  return parsed.data;
}

export function saveSettings(settings: Settings): void {
  ensureDir(appDataDir());
  writeFileSync(settingsPath(), `${JSON.stringify(settingsSchema.parse(settings), null, 2)}\n`);
}

/** Settings plus auto-detection for anything the user has not pinned. */
export function resolveSettings(settings: Settings = loadSettings()): ResolvedSettings {
  return {
    ...settings,
    saveDir: settings.saveDir ?? findSaveDir() ?? detectedSaveDir(),
    gameDir: settings.gameDir ?? findGameDir(),
  };
}

/**
 * Every save tree on this machine, best first.
 *
 * Two locations, and which one is real depends on the *store and its settings*
 * rather than on the platform:
 *
 *   - **Steam with cloud saves on** writes to `userdata/<accountId>/219990/
 *     remote/save`. That is the normal Steam setup and the one this machine uses.
 *   - **GOG, and Steam with cloud saves off**, write to
 *     `Documents/My Games/Grim Dawn/save` — inside the wrapper's fake Windows
 *     profile under CrossOver, in the real one on Windows.
 *
 * A directory counts only if it has a `main/` in it, which is where characters
 * live: an empty `save` folder is left behind by an uninstall and would otherwise
 * shadow the tree that has the saves in it.
 */
export function findSaveDirs(): string[] {
  const found: string[] = [];
  for (const steam of steamRoots()) {
    const userdata = join(steam, 'userdata');
    for (const account of safeReaddir(userdata)) {
      found.push(join(userdata, account, STEAM_APP_ID, 'remote/save'));
    }
  }
  for (const documents of documentRoots()) {
    found.push(join(documents, 'My Games/Grim Dawn/save'));
  }
  return [...new Set(found)].filter((dir) => existsSync(join(dir, 'main')));
}

/** The best save tree, or nothing. `GD_SAVE_DIR` wins over all of it. */
export function findSaveDir(): string | undefined {
  if (process.env.GD_SAVE_DIR) return process.env.GD_SAVE_DIR;
  return findSaveDirs()[0];
}

/**
 * Character directory names in one of the save trees — the campaign by default,
 * `user` for the characters a Custom Game writes. The default keeps every
 * existing caller (the window, the session, the advisor) on the campaign, which
 * is the only tree the rest of the app models: a custom game's items come from a
 * mod's database, and this one reads the installed game's.
 */
export function listCharacters(saveDir: string, tree: SaveTree = 'main'): string[] {
  return safeReaddir(join(saveDir, tree))
    .filter((name) => existsSync(join(saveDir, tree, name, 'player.gdc')))
    .sort();
}
