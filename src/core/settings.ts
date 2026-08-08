/**
 * Persistent settings: `~/Library/Application Support/gd-companion/settings.json`.
 *
 * Every field has a working default, and the two path fields auto-detect, so the
 * file is optional — the tool runs correctly on this machine before it has ever
 * been written. Values are zod-validated on read: a hand-edited settings file
 * with a typo should say what is wrong, not produce mysterious behaviour later.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { appDataDir, ensureDir } from './db/cache.js';
import { findGameDir } from './db/gamefiles.js';
import { saveDir as detectedSaveDir } from './paths.js';

/** Grim Dawn's Steam app id — the userdata subdirectory to look for. */
const STEAM_APP_ID = '219990';
const CROSSOVER_BOTTLES = join(homedir(), 'Library/Application Support/CrossOver/Bottles');

export const settingsSchema = z.object({
  /** Root of the save tree: holds `main/<character>/` and the shared `.gst` files. */
  saveDir: z.string().min(1).optional(),
  /** Grim Dawn install directory (the one containing `database/database.arz`). */
  gameDir: z.string().min(1).optional(),
  /** Character whose `player.gdc` the UI opens by default. */
  activeCharacter: z.string().min(1).optional(),
  /**
   * The language item and skill names come out in — one of the locales the
   * install ships a `resources/Text_<LOCALE>.arc` for (`db --stats` lists them).
   */
  locale: z.string().min(2).default('en'),
  /** Advisor backend — see `src/core/ai/provider.ts` (Stage 6). */
  provider: z.string().min(1).default('claude-cli'),
  model: z.string().min(1).optional(),
  /** Force advice for a difficulty other than the character's current one. */
  difficultyOverride: z.enum(['Normal', 'Elite', 'Ultimate']).optional(),
});

export type Settings = z.infer<typeof settingsSchema>;

/** Settings with the two path fields resolved — what callers actually want. */
export interface ResolvedSettings extends Settings {
  saveDir: string;
  /** Undefined only when Grim Dawn is not installed on this machine. */
  gameDir: string | undefined;
}

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

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Locate the save tree.
 *
 * Steam Cloud's `userdata/<accountId>/219990/remote/save` is the authoritative
 * location when cloud saves are on — which is the normal setup, and the one this
 * machine uses. The `My Games` path inside the bottle is the fallback for cloud
 * saves turned off. `GD_SAVE_DIR` still wins over both (see `paths.ts`).
 */
export function findSaveDir(): string | undefined {
  if (process.env.GD_SAVE_DIR) return process.env.GD_SAVE_DIR;

  for (const bottle of safeReaddir(CROSSOVER_BOTTLES)) {
    const driveC = join(CROSSOVER_BOTTLES, bottle, 'drive_c');
    const userdata = join(driveC, 'Program Files (x86)/Steam/userdata');
    for (const account of safeReaddir(userdata)) {
      const candidate = join(userdata, account, STEAM_APP_ID, 'remote/save');
      if (existsSync(join(candidate, 'main'))) return candidate;
    }

    const users = join(driveC, 'users');
    for (const user of safeReaddir(users)) {
      const candidate = join(users, user, 'Documents/My Games/Grim Dawn/save');
      if (existsSync(join(candidate, 'main'))) return candidate;
    }
  }
  return undefined;
}

/** Character directory names under `<saveDir>/main`. */
export function listCharacters(saveDir: string): string[] {
  return safeReaddir(join(saveDir, 'main'))
    .filter((name) => existsSync(join(saveDir, 'main', name, 'player.gdc')))
    .sort();
}
