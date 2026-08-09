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

import type { AdvisePhase, AdviseStatus, AdviseEnvelope, AdviseUsage } from '../core/ai/envelope.js';
import type { AdvisorPlan, PlanWarning, VerdictRow } from '../core/ai/provider.js';
import type { Settings } from '../core/settings-schema.js';
import type { Difficulty } from '../core/save/types.js';
import type { UiSnapshot } from './view.js';

export type {
  AdviseEnvelope,
  AdvisePhase,
  AdviseStatus,
  AdviseUsage,
  AdvisorPlan,
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
}

export type PushEvent =
  | { type: 'advise-progress'; runId: string; phase: 'context' | 'asking' | 'repair'; elapsedMs: number }
  | { type: 'advise-done'; runId: string; envelope: AdviseEnvelope }
  | { type: 'advise-error'; runId: string; message: string }
  | { type: 'db-progress'; message: string }
  | { type: 'snapshot-invalidated' };

export interface GdApi {
  getBootstrap(): Promise<Bootstrap>;
  getSnapshot(character?: string): Promise<UiSnapshot>;
  setActiveCharacter(name: string): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  /** Re-read the save and rebuild the snapshot; the database is untouched. */
  refresh(): Promise<UiSnapshot>;
  /** Implemented in Stage 7B. */
  startAdvise(req: { question?: string }): Promise<{ runId: string }>;
  cancelAdvise(runId: string): Promise<void>;
  getAdviseStatus(): Promise<AdviseStatus>;
  getLastAdvice(character: string): Promise<AdviseEnvelope | null>;
  /** Subscribe to pushes; the returned function unsubscribes. */
  onPush(cb: (e: PushEvent) => void): () => void;
}

/** Every request channel, so main and preload cannot spell one differently. */
export const IPC_CHANNELS = [
  'getBootstrap',
  'getSnapshot',
  'setActiveCharacter',
  'updateSettings',
  'refresh',
  'startAdvise',
  'cancelAdvise',
  'getAdviseStatus',
  'getLastAdvice',
] as const satisfies readonly (keyof GdApi)[];

export type IpcChannel = (typeof IPC_CHANNELS)[number];

/** The single push channel main sends `PushEvent`s down. */
export const PUSH_CHANNEL = 'gd:push';

/** Difficulty choices the header offers; `undefined` means "what the save says". */
export const DIFFICULTY_CHOICES: readonly Difficulty[] = ['Normal', 'Elite', 'Ultimate'];
