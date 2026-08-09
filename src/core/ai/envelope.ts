/**
 * One advice run, as a value.
 *
 * Stage 6C wrote this shape inline in the CLI's `--json` handler so that Stage
 * 7 would have a file to consume rather than prose to re-parse. Naming the type
 * here is what lets the IPC contract mention it without the window importing
 * the CLI — and what lets Stage 7B store a run, replay it after a reload, and
 * join its ids onto the live grid.
 *
 * **Schema, not interface.** A stored envelope is read back from a file written
 * by whatever build wrote it, so the shape has to be *validated* rather than
 * asserted: an older or newer file must degrade to "there is no last advice",
 * never to a renderer reading fields that are not there. The types stay
 * inferred, so there is still exactly one definition of each.
 *
 * Two constraints on this module, both mechanical. It is in the renderer's type
 * graph via `src/shared/ipc.ts`, which compiles with `types: []` — so **nothing
 * here may reach a Node builtin**, which is why the persistence half of Stage
 * 7B's plan lives next door in `advice-store.ts` rather than in this file. And
 * everything here must survive the structured clone algorithm.
 */

import { z } from 'zod';

import {
  advisorPlanSchema,
  planWarningSchema,
  verdictRows,
  verdictRowSchema,
  type AdvisorPlan,
  type AdvisorResult,
  type PlanWarning,
} from './provider.js';

export const adviseUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
});

export type AdviseUsage = z.infer<typeof adviseUsageSchema>;

export const adviseEnvelopeSchema = z.object({
  character: z.string(),
  /** ISO timestamp — when the run finished. */
  generatedAt: z.string(),
  gameVersion: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  /**
   * What the user asked on top of the dossier, when they asked anything.
   *
   * Optional rather than empty-string-by-default so a run with no question is
   * byte-identical to what Stage 6C's `--json` already wrote — the file has
   * consumers, and the point of naming the type was to stop it drifting.
   */
  question: z.string().optional(),
  /** How many model calls the repair loop spent; 2 means a revision happened. */
  calls: z.number(),
  usage: adviseUsageSchema,
  durationMs: z.number(),
  /** What survived the checks on the answer that is being shown. */
  warnings: planWarningSchema.array(),
  /**
   * What the *first* call got wrong. Kept because the surviving warnings say
   * nothing about how much repair it took to get there, and two runs on one
   * dossier are only comparable if that is visible.
   */
  firstWarnings: planWarningSchema.array(),
  revised: z.boolean(),
  /** True when the revision came back no better and the original was kept. */
  revisionRejected: z.boolean(),
  /** The model's own markdown. The human product; the JSON sits beside it. */
  answer: z.string(),
  plan: advisorPlanSchema.nullable(),
  /** Derived once, so the CLI table and the window's grid cannot disagree. */
  verdictRows: verdictRowSchema.array(),
  /** Document id → display name, for both items and socketables. */
  itemNames: z.record(z.string(), z.string()),
  socketableNames: z.record(z.string(), z.string()),
});

export type AdviseEnvelope = z.infer<typeof adviseEnvelopeSchema>;

/**
 * What `adviseWithRepair` returns, named structurally.
 *
 * `RepairOutcome` itself lives in `repair.ts`, which imports `checkPlan` — and
 * through it the resolver and the database types. Importing it here would drag
 * all of that into the renderer's type graph for the sake of six field names.
 * A `RepairOutcome` is assignable to this, which is the whole requirement.
 */
export interface AdviseRun {
  result: AdvisorResult;
  warnings: readonly PlanWarning[];
  firstWarnings: readonly PlanWarning[];
  revised: boolean;
  revisionRejected: boolean;
  /** Every call the run made — its length is the `calls` count. */
  results: readonly AdvisorResult[];
}

export interface BuildEnvelopeArgs {
  character: string;
  gameVersion: string;
  /** The extra instruction, if the caller had one. */
  question?: string | undefined;
  outcome: AdviseRun;
  /**
   * Usage across **every** call the repair loop made, not just the one whose
   * answer is shown: the second call is spent whether or not it wins. Passed in
   * rather than summed here because `totalUsage` already owns that reduction,
   * and it lives on the other side of the import boundary above.
   */
  usage: AdviseUsage;
  durationMs: number;
  /** Defaults to now. A test pins it; nothing else should. */
  generatedAt?: string;
  /** Every id the dossier defined, to the name it printed. */
  itemNames: Record<string, string>;
  socketableNames: Record<string, string>;
}

/**
 * Assemble the envelope from a finished run.
 *
 * Field-for-field what the CLI used to write inline, so an existing `--json`
 * consumer sees no change — and now there is one producer, which is what makes
 * the main process's runs and the CLI's the same artefact rather than two
 * shapes that happen to look alike.
 *
 * `verdictRows` is derived here rather than by each caller, for the reason it
 * was derived in the CLI: the terminal table and the window's grid must not be
 * able to disagree about which rows are swaps.
 */
export function buildEnvelope(args: BuildEnvelopeArgs): AdviseEnvelope {
  const { outcome } = args;
  const result = outcome.result;
  const plan: AdvisorPlan | null = result.structured ?? null;

  return {
    character: args.character,
    generatedAt: args.generatedAt ?? new Date().toISOString(),
    gameVersion: args.gameVersion,
    provider: result.provider,
    model: result.model ?? null,
    effort: result.effort ?? null,
    ...(args.question ? { question: args.question } : {}),
    calls: outcome.results.length,
    usage: args.usage,
    durationMs: args.durationMs,
    warnings: [...outcome.warnings],
    firstWarnings: [...outcome.firstWarnings],
    revised: outcome.revised,
    revisionRejected: outcome.revisionRejected,
    answer: result.text,
    plan,
    verdictRows: plan ? verdictRows(plan, (id) => args.itemNames[id]) : [],
    itemNames: args.itemNames,
    socketableNames: args.socketableNames,
  };
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
