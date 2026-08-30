/**
 * The contract between the Electron main process and the renderer.
 *
 * Defined **whole**, advise channels included, even though Stage 7B is what
 * implements them: a contract that grows channel by channel is a contract the
 * two sides can drift on, and `registerHandlers(api: GdApi)` in the main
 * process turns a missing channel into a compile error rather than a rejected
 * promise at runtime.
 *
 * Same two rules as `view.ts`: everything here must survive the structured
 * clone algorithm, and nothing in this module's type graph may import a Node
 * builtin.
 */

import type {
  AdviceRunRef,
  AdviseActivityState,
  AdvisePhase,
  AdviseStatus,
  AdviseEnvelope,
  AdviseUsage,
  PlanProjection,
} from '../core/ai/envelope.js';
import type { AdvisorPlan, PlanWarning, VerdictRow } from '../core/ai/provider.js';
import type { Settings } from '../core/settings-schema.js';
import type { Difficulty } from '@grimdawn/core/save/types';
import type { UiSnapshot } from './view.js';

export type {
  AdviceRunRef,
  AdviseActivityState,
  AdviseEnvelope,
  AdvisePhase,
  AdviseStatus,
  AdviseUsage,
  AdvisorPlan,
  PlanProjection,
  PlanWarning,
  Settings,
  UiSnapshot,
  VerdictRow,
};
export type * from './view.js';
export type { AdviceMark } from './advice-marks.js';

/**
 * `gdicon://tex/<arc-relative .tex path>`.
 *
 * Item icons only. An earlier draft dressed the window in the game's own
 * `UI.arc` chrome — frames, slot placeholders, 9-slice panels — and it was
 * dropped: the art is built for the engine's fixed layout, so at any size the
 * app actually uses it overlaps and fights the content instead of framing it.
 * The icons are the part that carries information; the frames were decoration
 * that cost legibility.
 *
 * Segments are encoded individually: encoding the whole path would turn its
 * separators into `%2F`, which Chromium normalizes back, and the round trip is
 * not worth relying on.
 */
export function gdiconUrl(texPath: string): string {
  return `gdicon://tex/${texPath.split('/').map(encodeURIComponent).join('/')}`;
}

// ---------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------

export interface Bootstrap {
  settings: Settings;
  /** Character directory names under `<saveDir>/main`. */
  characters: string[];
  active?: string;
  /** Set when the game is not installed (or `gameDir` points somewhere wrong). */
  gameDirProblem?: string;
  /** Where saves are being read from — worth showing when the list is empty. */
  saveDir: string;
  /**
   * The install actually in use, auto-detected when `settings.gameDir` is blank.
   * The settings pane shows it as the placeholder, so "auto" is a value the
   * reader can see rather than a word they have to trust.
   */
  gameDir?: string;
  /**
   * Locale codes this install ships a `Text_<LOCALE>.arc` for. Thirteen on a
   * full install; empty when the game cannot be found at all.
   */
  locales: string[];
}

export type PushEvent =
  | { type: 'advise-progress'; runId: string; phase: 'context' | 'asking' | 'repair'; elapsedMs: number }
  /**
   * A chunk of what the model has just written, coalesced in main to a few a
   * second. A separate event from `advise-progress` because the two have different
   * rates and different meanings: a phase change is rare and structural, this is
   * continuous.
   *
   * A **delta**, not a snapshot: the renderer accumulates the whole transcript, so
   * sending the accumulation each time would re-marshal a hundred kilobytes across
   * the process boundary several times a second to append a few words to it. The
   * *tail* on `AdviseStatus` is the snapshot, and it exists for the other case —
   * a window that mounts nine minutes in and has no transcript to append to.
   */
  | { type: 'advise-activity'; runId: string; kind: 'thinking' | 'answer'; text: string; outputTokens?: number }
  | { type: 'advise-done'; runId: string; envelope: AdviseEnvelope }
  | { type: 'advise-error'; runId: string; message: string }
  | { type: 'db-progress'; message: string }
  /**
   * The watcher read a save the game had just written and could not make sense
   * of it, even after retrying and after trying the rotation backups.
   *
   * Separate from `error`, which means the window has nothing to show. Here it
   * still has the last good snapshot on screen — it is simply not the newest one,
   * and saying so beats a window that quietly stops keeping up.
   */
  | { type: 'save-problem'; message: string }
  /**
   * The menu bar asking the window to open something. The menu is in main and
   * the panes are in the renderer, so this is the only way across — and it is a
   * push rather than a channel because nothing is being asked *for*.
   */
  | { type: 'open-pane'; pane: 'settings' | 'context' }
  | { type: 'snapshot-invalidated' };

/** What the app calls itself, in the window, the menu bar and the About box. */
export const APP_NAME = 'Grim Dawn AI Companion';

/**
 * What the *context viewer* shows: the document as the advisor would receive it.
 *
 * The point of it is answering "what did the model actually see" in one click —
 * which is also how a difficulty override is verified, since the override's whole
 * effect is on the numbers in this text.
 */
export interface ContextDocumentView {
  character: string;
  difficulty: Difficulty;
  markdown: string;
  tokenEstimate: number;
  /** Whether personal and transfer stashes are included as upgrade sources. */
  stashIncluded: boolean;
  /** Whether included stored gear owes an equip/hold/sell disposition. */
  stashReviewForSale: boolean;
}

/** Where the tool can see a Grim Dawn install and its saves on this machine. */
export interface DetectedPaths {
  saveDirs: string[];
  gameDirs: string[];
}

export interface GdApi {
  getBootstrap(): Promise<Bootstrap>;
  /** Put plain text on the system clipboard. */
  copyText(text: string): Promise<void>;
  getSnapshot(character?: string): Promise<UiSnapshot>;
  setActiveCharacter(name: string): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  /** Re-read the save and rebuild the snapshot; the database is untouched. */
  refresh(): Promise<UiSnapshot>;
  /** Implemented in Stage 7B. */
  startAdvise(req: { question?: string }): Promise<{ runId: string }>;
  cancelAdvise(runId: string): Promise<void>;
  getAdviseStatus(): Promise<AdviseStatus>;
  /**
   * Every stored run for a character, newest first.
   *
   * There is deliberately **no "open the newest one" channel**, and no delete.
   * The window starts on the empty state and a run is opened by picking it:
   * reopening last week's answer on every launch puts a stale plan's marks on the
   * gear before the reader has asked for them, and makes "is this still about what
   * I am wearing?" the first question of every session rather than one they chose
   * to ask. And nothing removes a run — each is minutes and real money, so the
   * fresh-session control had to stop being a delete button (it is now `New run`,
   * which selects nothing and destroys nothing).
   */
  getAdviceHistory(character: string): Promise<AdviceRunRef[]>;
  getAdvice(character: string, id: string): Promise<AdviseEnvelope | null>;
  /**
   * The context document the next advice run would send.
   *
   * A debug affordance with one real job: it is the only place the effect of the
   * difficulty override and the stash toggle is *visible* rather than asserted.
   */
  getContextDocument(): Promise<ContextDocumentView>;
  /**
   * Where an install and its saves appear to be. The settings pane offers these
   * beside the two text fields — a path you can pick beats a path you have to
   * know, and the fields stay editable for the installs nobody can guess.
   */
  detectPaths(): Promise<DetectedPaths>;
  /** Subscribe to pushes; the returned function unsubscribes. */
  onPush(cb: (e: PushEvent) => void): () => void;
}

/** Every request channel, so main and preload cannot spell one differently. */
export const IPC_CHANNELS = [
  'getBootstrap',
  'copyText',
  'getSnapshot',
  'setActiveCharacter',
  'updateSettings',
  'refresh',
  'startAdvise',
  'cancelAdvise',
  'getAdviseStatus',
  'getAdviceHistory',
  'getAdvice',
  'getContextDocument',
  'detectPaths',
] as const satisfies readonly (keyof GdApi)[];

export type IpcChannel = (typeof IPC_CHANNELS)[number];

/** The single push channel main sends `PushEvent`s down. */
export const PUSH_CHANNEL = 'gd:push';

/** Difficulty choices the header offers; `undefined` means "what the save says". */
export const DIFFICULTY_CHOICES: readonly Difficulty[] = ['Normal', 'Elite', 'Ultimate'];
