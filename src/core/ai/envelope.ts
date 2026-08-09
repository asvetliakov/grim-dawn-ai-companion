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
  /**
   * What the character was wearing when the run started: the document's own slot
   * label → the item's document id, empty slots omitted.
   *
   * This is the answer to "is this advice still about the save in front of me".
   * A stored run is shown again on the next launch, and by then the player may
   * have equipped something, sold something, or played for a week — and an
   * envelope with no record of the loadout it was written for cannot tell any of
   * those apart from a plan that is still current.
   *
   * The **slot map rather than a hash** is deliberate, and it is the difference
   * between a warning and a useful one. A hash answers "did anything change";
   * this answers "which slot, from what, to what" — which is what makes
   * `EQUIP`-already-carried-out distinguishable from the loadout drifting out
   * from under the advice. The first is the plan *working* and must never be
   * reported as staleness, because carrying out the advice is precisely what
   * changes the loadout: a tool that discarded its own answer the moment you
   * acted on it would be unusable.
   *
   * Optional, so a run stored before this field existed still validates and
   * simply cannot be checked.
   */
  worn: z.record(z.string(), z.string()).optional(),
  /**
   * What each worn item was *carrying* — socketable ids by slot.
   *
   * Needed because **an item's id includes its attachments**: `itemId` hashes
   * `relicName`/`relicSeed` (the save's word for a component) and
   * `augmentName`/`augmentSeed` along with the base and its affixes. So carrying
   * out an `ADD-COMPONENT` changes the worn item's id without changing the item,
   * and `worn` alone cannot tell that apart from the item being replaced — it
   * would report "Feet now holds Bloodhound Greaves (was Bloodhound Greaves)",
   * which is both useless and the *opposite* of the truth, since what actually
   * happened is that the reader did what the plan said.
   *
   * A separate field rather than a richer `worn`, so a stored run written before
   * this existed still validates: changing `worn`'s value type would fail the
   * whole envelope and silently discard a four-dollar answer.
   */
  wornSockets: z
    .record(z.string(), z.object({ component: z.string().optional(), augment: z.string().optional() }))
    .optional(),
  /**
   * Whether the dossier this run answered included the stashes.
   *
   * Scope is part of the answer's identity: a run that never saw the personal
   * and transfer stash is not *wrong* about them — it was not asked. Optional so
   * every run stored before the toggle existed still validates; those runs all
   * included the stash, and a reader may treat `undefined` as `true`.
   */
  stashIncluded: z.boolean().optional(),
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
  /**
   * Slot label → worn item id, at the moment the run started. Optional so an
   * older caller still compiles; a run without it just cannot be staleness-checked.
   */
  worn?: Record<string, string>;
  /** Slot label → the socketable ids that item was carrying. See the schema. */
  wornSockets?: Record<string, { component?: string; augment?: string }>;
  /** Whether the dossier included the stashes. See the schema field. */
  stashIncluded?: boolean;
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
    ...(args.worn ? { worn: args.worn } : {}),
    ...(args.wornSockets ? { wornSockets: args.wornSockets } : {}),
    ...(args.stashIncluded !== undefined ? { stashIncluded: args.stashIncluded } : {}),
  };
}

/**
 * The worn-slot map for `worn`, from the resolved items.
 *
 * Keyed on the resolver's own `location` string, which is the same label §5 of
 * the dossier prints as a heading and therefore the same one the model writes
 * back in `verdicts[].slot` — that identity is what lets a stored run be lined up
 * against a live save without a second mapping table to keep honest.
 *
 * Argument typed structurally so this stays in the renderer's type graph: a
 * `ResolvedItem[]` is assignable to it, and importing the resolver here would
 * drag the database types across the boundary.
 */
export function wornSlots(
  items: readonly { source: string; location: string; id: string }[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of items) {
    if (item.source === 'equipped') out[item.location] = item.id;
  }
  return out;
}

/**
 * The socketables each worn item is carrying, for `wornSockets`.
 *
 * By **record path hashed the same way the dossier hashes a socketable** —
 * `shortHash(record)` — because that is the id a plan's `targetId` carries, and
 * lining the two up is the whole purpose. Passed in as `idFor` rather than
 * imported: `shortHash` lives in the resolver, and this module is in the
 * renderer's type graph.
 */
export function wornSocketables(
  items: readonly { source: string; location: string; component?: { record: string }; augment?: { record: string } }[],
  idFor: (record: string) => string,
): Record<string, { component?: string; augment?: string }> {
  const out: Record<string, { component?: string; augment?: string }> = {};
  for (const item of items) {
    if (item.source !== 'equipped') continue;
    const entry = {
      ...(item.component ? { component: idFor(item.component.record) } : {}),
      ...(item.augment ? { augment: idFor(item.augment.record) } : {}),
    };
    if (entry.component || entry.augment) out[item.location] = entry;
  }
  return out;
}

/**
 * One stored run, as the picker sees it.
 *
 * A summary rather than the envelope: the list is built by reading every file in
 * the character's advice directory, and shipping ~70 kB per entry to populate a
 * `<select>` would be paying for fourteen answers to show one. The chosen run is
 * fetched whole.
 *
 * The fields are the ones that distinguish two runs on the same save at a glance:
 * when, at what cost, with how many verdicts and how many surviving warnings —
 * and the question, which is usually *why* there is a second run at all.
 */
export interface AdviceRunRef {
  /** The store's filename stem; opaque to the renderer, which passes it back. */
  id: string;
  generatedAt: string;
  model: string | null;
  calls: number;
  costUsd: number;
  verdicts: number;
  warnings: number;
  question?: string;
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
  /**
   * The tail of what the model is currently writing, when the backend streams.
   *
   * Carried on `status()` and not only on the push, because a renderer that
   * mounts nine minutes into a run would otherwise re-attach to a phase label and
   * a clock and nothing else — the very state the streaming exists to improve on.
   */
  activity?: AdviseActivityState;
}

/** The live tail of a streaming run: what kind of writing, and how much so far. */
export interface AdviseActivityState {
  kind: 'thinking' | 'answer';
  /**
   * The last few hundred characters of the **reasoning**, not the transcript —
   * and **only for a window that arrives late**.
   *
   * The panel does show the whole reasoning, but it builds it from the deltas on
   * `advise-activity`: sending the accumulation on every push would re-marshal a
   * hundred kilobytes across the process boundary several times a second to append
   * a few words to it. So this is not what the panel renders in the normal case. It
   * is what a renderer that mounted nine minutes in has instead of a transcript,
   * which is why the panel labels it as a fragment rather than presenting it as the
   * whole. Reasoning only, like the transcript itself: the answer's own text is
   * never streamed into the box, only counted.
   */
  tail: string;
  outputTokens?: number;
}
