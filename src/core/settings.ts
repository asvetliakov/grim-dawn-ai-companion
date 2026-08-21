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

import { appDataDir } from './data-dir.js';
import { ensureDir } from '@grimdawn/core/db/cache';
import { findGameDir } from '@grimdawn/core/db/gamefiles';
import { findSaveDir, saveDir as detectedSaveDir } from '@grimdawn/core/paths';
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

