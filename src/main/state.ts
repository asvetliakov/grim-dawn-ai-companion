/**
 * The window's session: one settings object, one database, one snapshot.
 *
 * There is exactly one window and one character on screen at a time, so the
 * state is a mutable record rather than a store — anything heavier would be
 * ceremony. What it does owe the rest of the app is *honest invalidation*:
 * changing the game directory or the locale invalidates the database and every
 * icon derived from it, while changing character or difficulty invalidates only
 * the snapshot. Getting that backwards means either a stale window or a
 * thirty-second rebuild on a dropdown change.
 */

import { loadGameDb } from '../core/db/index.js';
import type { GameDb } from '../core/db/types.js';
import { MISSING_GAME_DIR_MESSAGE } from '../core/db/gamefiles.js';
import { createIconService, type IconService } from '../core/icons/index.js';
import { loadSnapshot, SessionError, type CharacterSnapshot } from '../core/session.js';
import { listCharacters, loadSettings, resolveSettings, saveSettings } from '../core/settings.js';
import type { ResolvedSettings, Settings } from '../core/settings-schema.js';
import { buildUiSnapshot } from '../core/view.js';
import type { Bootstrap, PushEvent } from '../shared/ipc.js';
import type { UiSnapshot } from '../shared/view.js';

/** What a change to a settings field costs. */
const REBUILDS_DB: readonly (keyof Settings)[] = ['gameDir', 'locale'];

export type PushFn = (event: PushEvent) => void;

export class SessionState {
  private settings: Settings = loadSettings();
  private resolved: ResolvedSettings = resolveSettings(this.settings);
  private db: GameDb | undefined;
  private icons: IconService | undefined;
  private snapshot: UiSnapshot | undefined;
  /** In-flight database load, so two callers never build it twice. */
  private loading: Promise<GameDb> | undefined;
  private character: string | undefined;

  constructor(private readonly push: PushFn) {}

  /**
   * Everything the window needs before it can draw anything. Deliberately does
   * **not** build the database: a first boot takes half a minute, and the
   * window must be up and reporting progress for all of it rather than blank.
   */
  async getBootstrap(): Promise<Bootstrap> {
    const characters = listCharacters(this.resolved.saveDir);
    const active = this.character ?? this.settings.activeCharacter ?? characters[0];
    const boot: Bootstrap = {
      settings: this.settings,
      characters,
      saveDir: this.resolved.saveDir,
    };
    if (active) boot.active = active;
    if (!this.resolved.gameDir) boot.gameDirProblem = MISSING_GAME_DIR_MESSAGE;
    return boot;
  }

  async getSnapshot(character?: string): Promise<UiSnapshot> {
    if (character && character !== this.character) {
      this.character = character;
      this.snapshot = undefined;
    }
    if (this.snapshot) return this.snapshot;
    return this.rebuildSnapshot();
  }

  async refresh(): Promise<UiSnapshot> {
    return this.rebuildSnapshot();
  }

  async setActiveCharacter(name: string): Promise<void> {
    if (name === this.character) return;
    this.character = name;
    this.snapshot = undefined;
    // Remembered across restarts: reopening on whoever you were last looking at
    // is the whole point of the setting.
    this.persist({ ...this.settings, activeCharacter: name });
    this.push({ type: 'snapshot-invalidated' });
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    const next = { ...this.settings, ...patch };
    const dbChanged = REBUILDS_DB.some((key) => next[key] !== this.settings[key]);
    this.persist(next);

    if (dbChanged) {
      this.icons?.close();
      this.db = undefined;
      this.icons = undefined;
      this.loading = undefined;
    }
    this.snapshot = undefined;
    this.push({ type: 'snapshot-invalidated' });
    return this.settings;
  }

  dispose(): void {
    this.icons?.close();
    this.icons = undefined;
  }

  /** The icon service, for the `gdicon://` handler. Undefined without a game dir. */
  async iconService(): Promise<IconService | undefined> {
    if (this.icons) return this.icons;
    if (!this.resolved.gameDir) return undefined;
    try {
      this.icons = createIconService({ gameDir: this.resolved.gameDir });
    } catch {
      // A missing or unreadable install is an ordinary answer here: the window
      // falls back to text-only items rather than failing outright.
      return undefined;
    }
    return this.icons;
  }

  private persist(next: Settings): void {
    this.settings = next;
    this.resolved = resolveSettings(next);
    saveSettings(next);
  }

  private async gameDb(): Promise<GameDb> {
    if (this.db) return this.db;
    if (!this.loading) {
      this.loading = loadGameDb({
        ...(this.resolved.gameDir ? { gameDir: this.resolved.gameDir } : {}),
        ...(this.settings.locale ? { locale: this.settings.locale } : {}),
        onProgress: (message) => this.push({ type: 'db-progress', message }),
      });
    }
    try {
      this.db = await this.loading;
      return this.db;
    } catch (err) {
      // Let the next attempt try again rather than latching the failure — the
      // user may be about to point `gameDir` somewhere real.
      this.loading = undefined;
      throw err;
    }
  }

  private async rebuildSnapshot(): Promise<UiSnapshot> {
    const db = await this.gameDb();
    const icons = await this.iconService();
    if (!icons) throw new Error(MISSING_GAME_DIR_MESSAGE);

    let snap: CharacterSnapshot;
    try {
      snap = loadSnapshot(db, this.resolved, { character: this.character });
    } catch (err) {
      // Typed session failures are the user's situation, not a crash: no
      // characters yet, a save the game is mid-write on. Re-thrown with the
      // message the window should show.
      if (err instanceof SessionError) throw new Error(err.message);
      throw err;
    }
    this.character = snap.character;
    this.snapshot = await buildUiSnapshot(snap, icons);
    return this.snapshot;
  }
}
