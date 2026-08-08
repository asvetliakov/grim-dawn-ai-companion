import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadSettings, resolveSettings, saveSettings, settingsPath } from '../src/core/settings.js';

/**
 * Settings live under `GD_DATA_DIR`, which exists exactly so these tests can run
 * against a throwaway directory instead of the user's real configuration.
 */
describe('settings', () => {
  const original = process.env.GD_DATA_DIR;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gd-settings-'));
    process.env.GD_DATA_DIR = dir;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.GD_DATA_DIR;
    else process.env.GD_DATA_DIR = original;
  });

  it('returns working defaults when no file exists', () => {
    const settings = loadSettings();
    expect(settings.locale).toBe('en');
    expect(settings.provider).toBe('claude-cli');
    expect(settings.saveDir).toBeUndefined();
  });

  it('round-trips through the file', () => {
    saveSettings({ locale: 'de', provider: 'claude-cli', activeCharacter: '_Suchka' });
    expect(loadSettings()).toMatchObject({ locale: 'de', activeCharacter: '_Suchka' });
  });

  it('names the offending field when the file is invalid', () => {
    writeFileSync(settingsPath(), JSON.stringify({ locale: 5, difficultyOverride: 'Nightmare' }));
    expect(() => loadSettings()).toThrow(/locale/);
    expect(() => loadSettings()).toThrow(/difficultyOverride/);
  });

  it('reports malformed JSON as such rather than falling back to defaults', () => {
    writeFileSync(settingsPath(), '{ not json');
    expect(() => loadSettings()).toThrow(/not valid JSON/);
  });

  it('keeps an explicitly configured path instead of auto-detecting over it', () => {
    const resolved = resolveSettings({ saveDir: '/pinned/save', gameDir: '/pinned/game', locale: 'en', provider: 'claude-cli' });
    expect(resolved.saveDir).toBe('/pinned/save');
    expect(resolved.gameDir).toBe('/pinned/game');
  });
});
