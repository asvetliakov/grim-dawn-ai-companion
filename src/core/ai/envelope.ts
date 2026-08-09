/**
 * One advice run, as a value.
 *
 * Stage 6C wrote this shape inline in the CLI's `--json` handler so that Stage
 * 7 would have a file to consume rather than prose to re-parse. Naming the type
 * here is what lets the IPC contract mention it without the window importing
 * the CLI — and what will let Stage 7B store a run, replay it after a reload,
 * and join its ids onto the live grid.
 *
 * Types only. The producer stays in the CLI until 7B moves it, deliberately: a
 * refactor of the writer belongs in the stage that gains a second caller for
 * it, not in the one that only needs to name the result.
 */

import type { AdvisorPlan, PlanWarning, VerdictRow } from './provider.js';

export interface AdviseUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface AdviseEnvelope {
  character: string;
  /** ISO timestamp — when the run finished. */
  generatedAt: string;
  gameVersion: string;
  provider: string;
  model: string | null;
  effort: string | null;
  /** How many model calls the repair loop spent; 2 means a revision happened. */
  calls: number;
  usage: AdviseUsage;
  durationMs: number;
  /** What survived the checks on the answer that is being shown. */
  warnings: PlanWarning[];
  /**
   * What the *first* call got wrong. Kept because the surviving warnings say
   * nothing about how much repair it took to get there, and two runs on one
   * dossier are only comparable if that is visible.
   */
  firstWarnings: PlanWarning[];
  revised: boolean;
  /** True when the revision came back no better and the original was kept. */
  revisionRejected: boolean;
  /** The model's own markdown. The human product; the JSON sits beside it. */
  answer: string;
  plan: AdvisorPlan | null;
  /** Derived once, so the CLI table and the window's grid cannot disagree. */
  verdictRows: VerdictRow[];
  /** Document id → display name, for both items and socketables. */
  itemNames: Record<string, string>;
  socketableNames: Record<string, string>;
}

/** What the main process reports about the run in flight, if any. */
export type AdvisePhase = 'idle' | 'context' | 'asking' | 'repair' | 'done' | 'error';

export interface AdviseStatus {
  phase: AdvisePhase;
  runId?: string;
  character?: string;
  /** Wall clock since the run started — a real call is ~500 s, so it matters. */
  elapsedMs?: number;
  message?: string;
}
