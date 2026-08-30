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

import { loadGameDb } from '@grimdawn/core/db';
import type { GameDb } from '@grimdawn/core/db/types';
import { findGameDirs, MISSING_GAME_DIR_MESSAGE } from '@grimdawn/core/db/gamefiles';
import { createIconService, type IconService } from '@grimdawn/core/icons';
import { adviceScope, loadSnapshot, SessionError, type CharacterSnapshot } from '../core/session.js';
import type { CharacterSave } from '@grimdawn/core/save/types';
import { findSaveDirs, listCharacters } from '@grimdawn/core/paths';
import { loadSettings, resolveSettings, saveSettings } from '../core/settings.js';
import type { ResolvedSettings, Settings } from '../core/settings-schema.js';
import { buildUiSnapshot } from '../core/view.js';
import { createSaveWatcher, type SaveWatcher } from '@grimdawn/core/watcher';
import { availableLocales } from '@grimdawn/core/db/gametext';
import type { Bootstrap, ContextDocumentView, DetectedPaths, PushEvent } from '../shared/ipc.js';
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
  /**
   * The snapshot the UI one was built *from*, kept because an advice run needs
   * the context document and the id maps that go with it — and it must be the
   * same document the window is showing, not a second one compiled a moment
   * later from a save the game may have rewritten in between. That identity is
   * the whole basis of the advice-to-item join.
   */
  private core: CharacterSnapshot | undefined;
  /** In-flight database load, so two callers never build it twice. */
  private loading: Promise<GameDb> | undefined;
  private character: string | undefined;
  private watcher: SaveWatcher | undefined;
  /**
   * The save the watcher has already read, waiting to be built into a snapshot.
   *
   * Handed on rather than re-read: the watcher got this one through the torn
   * write — retrying, and falling back to a rotation backup if the live file
   * never settled — and reading it again here would re-run that race with none
   * of the retries. It is consumed once and only for the character it belongs
   * to; an explicit Refresh drops it, because that button promises a fresh read.
   */
  private preparsed: { character: string; save: CharacterSave; path: string } | undefined;

  constructor(private readonly push: PushFn) {}

  /**
   * Watch the save tree, so the window keeps up with the game without being
   * asked to.
   *
   * Started explicitly rather than in the constructor: `fs.watch` on a directory
   * that does not exist throws, and a tool whose save path is wrong should open a
   * window that says so, not fail before there is a window to say it in.
   */
  startWatching(): void {
    this.watcher?.close();
    this.watcher = undefined;
    const saveDir = this.resolved.saveDir;
    try {
      this.watcher = createSaveWatcher({
        saveDir,
        onEvent: (event) => {
          if (event.type === 'parse-failed') {
            this.push({ type: 'save-problem', message: event.message });
            return;
          }
          if (event.type === 'character-updated') {
            // Another character's autosave is not this window's business — but
            // a *new* character is, so the invalidation still goes out and the
            // bootstrap's list picks it up.
            if (event.character !== this.character) {
              this.push({ type: 'snapshot-invalidated' });
              return;
            }
            this.preparsed = { character: event.character, save: event.save, path: event.path };
          }
          this.snapshot = undefined;
          this.core = undefined;
          this.push({ type: 'snapshot-invalidated' });
        },
      });
    } catch (err) {
      // A save directory that cannot be watched is not a reason to fail: the
      // window still reads it on demand, and Refresh still works.
      this.push({ type: 'save-problem', message: `cannot watch ${saveDir} — ${(err as Error).message}` });
    }
  }

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
      // Whatever `Text_<LOCALE>.arc` files this install actually ships — a
      // readdir, not a database build, so it is cheap enough for the bootstrap.
      locales: this.resolved.gameDir ? availableLocales(this.resolved.gameDir) : [],
    };
    if (active) boot.active = active;
    if (this.resolved.gameDir) boot.gameDir = this.resolved.gameDir;
    if (!this.resolved.gameDir) boot.gameDirProblem = MISSING_GAME_DIR_MESSAGE;
    return boot;
  }

  async getSnapshot(character?: string): Promise<UiSnapshot> {
    if (character && character !== this.character) {
      this.character = character;
      this.snapshot = undefined;
      this.core = undefined;
    }
    if (this.snapshot) return this.snapshot;
    return this.rebuildSnapshot();
  }

  async refresh(): Promise<UiSnapshot> {
    // The button says it reads your save file again, so it does — even if the
    // watcher has a perfectly good copy from four seconds ago.
    this.preparsed = undefined;
    return this.rebuildSnapshot();
  }

  /**
   * The character as `src/core` sees it — document, id maps and all.
   *
   * Builds it if the window has not asked for a snapshot yet, so an advice run
   * started from a cold window works rather than reporting nothing to advise on.
   */
  async characterSnapshot(): Promise<CharacterSnapshot> {
    if (!this.core) await this.rebuildSnapshot();
    // `rebuildSnapshot` either sets it or throws, so this cannot be reached
    // undefined; the assertion is for the compiler, not for the runtime.
    return this.core!;
  }

  /**
   * The document the next advice run would send, for the context viewer.
   *
   * Built through `adviceScope`, exactly as a run builds it, so both stash
   * scope choices show through — a viewer that rendered a different document
   * would be showing something no run has ever been sent.
   */
  async contextDocument(): Promise<ContextDocumentView> {
    const snap = await this.characterSnapshot();
    const stashIncluded = this.settings.includeStashInAdvice ?? true;
    const reviewStashForSale = stashIncluded && (this.settings.reviewStashForSale ?? false);
    const { doc } = adviceScope(snap, stashIncluded, { reviewStashForSale });
    return {
      character: snap.character,
      difficulty: snap.difficulty,
      markdown: doc.markdown,
      tokenEstimate: doc.tokenEstimate,
      stashIncluded,
      stashReviewForSale: doc.reviewStashForSale,
    };
  }

  /** Every save tree and install this machine appears to have. */
  detectPaths(): DetectedPaths {
    return { saveDirs: findSaveDirs(), gameDirs: findGameDirs() };
  }

  /** The version string the envelope records, so an old advice file can be dated. */
  async gameVersion(): Promise<string> {
    return (await this.gameDb()).gameVersion;
  }

  /** Provider, model, effort and timeout for a run — never inherited elsewhere. */
  currentSettings(): Settings {
    return this.settings;
  }

  async setActiveCharacter(name: string): Promise<void> {
    if (name === this.character) return;
    this.character = name;
    this.snapshot = undefined;
    this.core = undefined;
    // Remembered across restarts: reopening on whoever you were last looking at
    // is the whole point of the setting.
    this.persist({ ...this.settings, activeCharacter: name });
    this.push({ type: 'snapshot-invalidated' });
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    const next = { ...this.settings, ...patch };
    const dbChanged = REBUILDS_DB.some((key) => next[key] !== this.settings[key]);
    const saveDirWas = this.resolved.saveDir;
    this.persist(next);
    // A save tree that moved is a different set of files to watch, and the old
    // watch would keep reporting a directory nothing reads any more.
    if (this.resolved.saveDir !== saveDirWas) {
      this.preparsed = undefined;
      this.character = undefined;
      this.startWatching();
    }

    if (dbChanged) {
      this.icons?.close();
      this.db = undefined;
      this.icons = undefined;
      this.loading = undefined;
    }
    this.snapshot = undefined;
    this.core = undefined;
    this.push({ type: 'snapshot-invalidated' });
    return this.settings;
  }

  dispose(): void {
    this.watcher?.close();
    this.watcher = undefined;
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

    // Only for the character on screen, and only once: a save handed over by the
    // watcher describes the moment it was written, and a second snapshot built
    // from it later would be describing the past.
    const handed = this.preparsed?.character === this.character ? this.preparsed : undefined;
    this.preparsed = undefined;

    let snap: CharacterSnapshot;
    try {
      snap = loadSnapshot(db, this.resolved, {
        character: this.character,
        ...(handed ? { preparsed: { save: handed.save, path: handed.path } } : {}),
      });
    } catch (err) {
      // Typed session failures are the user's situation, not a crash: no
      // characters yet, a save the game is mid-write on. Re-thrown with the
      // message the window should show.
      if (err instanceof SessionError) throw new Error(err.message);
      throw err;
    }
    this.character = snap.character;
    this.core = snap;
    this.snapshot = await buildUiSnapshot(snap, icons);
    return this.snapshot;
  }
}
