/**
 * One corrective round-trip when the mechanical checks fail.
 *
 * `checkPlan` decides things the model got provably wrong — an item id that
 * exists nowhere in the dossier, a component proposed for a slot its use-on
 * restriction rejects, an extraction host the plan then also tells you to keep.
 * Until now those warnings went only to the user, so a plan that was one edit
 * from correct stayed broken. Showing the model its own warnings is the cheapest
 * fix available.
 *
 * **Exactly one revision.** Not a loop: each call is minutes and real money, and
 * a second failure is a signal to the user (or to whoever tunes the prompt), not
 * a reason to keep spending. Whichever result is clean wins, and the original is
 * kept when the revision is not an improvement — a revision that trades three
 * warnings for four is a regression, and losing the better answer to it would be
 * the repair loop making things worse.
 *
 * **And only for warnings that earn it.** A structural warning names a move the
 * tool cannot render or must not carry out; prose polish does not. Both live
 * runs spent a full second Opus call — six minutes and two dollars each — on
 * nothing but `ambiguous-stat`, and one of those revisions then failed to fix
 * it. Prose-only warnings are reported to the user and left standing.
 */

import type { ActivityListener, AdvisorProvider, AdvisorRequest, AdvisorResult } from './provider.js';
import { checkPlan, type PlanCheckInput, type PlanWarning, type PlanWarningKind } from './verify.js';

/** Warning kinds that are wording, not structure — never worth a second call. */
const PROSE_ONLY: ReadonlySet<PlanWarningKind> = new Set(['ambiguous-stat']);

/** Whether these warnings justify spending a corrective call. */
export function worthRepairing(warnings: readonly PlanWarning[]): boolean {
  return warnings.some((w) => !PROSE_ONLY.has(w.kind));
}

/**
 * The effort tier the corrective call runs at. A repair is an *edit* — "fix
 * exactly what the checks name, keep every other conclusion" — not fresh
 * optimisation, so it does not need the first call's reasoning depth; and
 * keep-whichever-is-cleaner already guards the case where the cheaper call
 * comes back worse. Tiers at or below medium pass through unchanged.
 */
export function repairEffort(effort: string): string {
  return effort === 'high' || effort === 'xhigh' || effort === 'max' || effort === 'ultra' ? 'medium' : effort;
}

export interface RepairOutcome {
  /** The answer to show: the revision when it is cleaner, else the original. */
  result: AdvisorResult;
  /** Warnings against `result` — empty when the repair succeeded. */
  warnings: PlanWarning[];
  /** Warnings the first answer had. Same as `warnings` when no revision ran. */
  firstWarnings: PlanWarning[];
  /** Whether a second call was actually made. */
  revised: boolean;
  /** True when the revision was asked for but came back no better, so it was discarded. */
  revisionRejected: boolean;
  /** Every call made, for a truthful cost line. */
  results: AdvisorResult[];
}

/** How the follow-up asks for a correction. */
export function repairRequest(req: AdvisorRequest, answer: string, warnings: readonly PlanWarning[]): AdvisorRequest {
  const list = warnings.map((w) => `- [${w.kind}] ${w.message}`).join('\n');
  return {
    ...req,
    question:
      `${req.question ? `${req.question}\n\n` : ''}` +
      'You have already answered this dossier once. Your previous answer is below, followed by the mechanical ' +
      'checks it failed. These checks are decided against the dossier, not opinions: an id that is not in the ' +
      'document does not exist, a use-on restriction is not negotiable, an extracted host is destroyed, and a ' +
      'bare damage-type name is ambiguous.\n\n' +
      'Produce a **corrected full answer** in the same format — every section, and one trailing JSON plan. Fix ' +
      'exactly what the checks name and keep every other conclusion you reached; if a check is wrong about the ' +
      'dossier, say so in one line and leave that part as it was.\n\n' +
      `## Checks failed\n\n${list}\n\n## Your previous answer\n\n${answer}`,
  };
}

export interface AdviseAndRepairOptions {
  /** False to report warnings without spending a second call. */
  repair?: boolean;
  /**
   * The provider the corrective call goes to, when the caller wants it cheaper
   * than the first — see `repairEffort`. Defaults to the same provider.
   */
  repairProvider?: AdvisorProvider;
  signal?: AbortSignal;
  /** Called before the second request, so a CLI can say what it is doing. */
  onRepair?: (warnings: readonly PlanWarning[]) => void;
  /**
   * Passed straight to both calls. Forwarded rather than wrapped: the consumer
   * already knows which phase it is in from `onRepair`, so re-labelling the
   * activity here would only give it a second, less reliable way to find out.
   */
  onActivity?: ActivityListener;
}

/**
 * Ask the provider, check the plan, and — when something is provably wrong —
 * ask once more with the warnings attached.
 */
export async function adviseWithRepair(
  provider: AdvisorProvider,
  req: AdvisorRequest,
  check: PlanCheckInput,
  opts: AdviseAndRepairOptions = {},
): Promise<RepairOutcome> {
  const first = await provider.advise(req, opts.signal, opts.onActivity);
  const firstWarnings = warningsFor(first, check);

  const base: RepairOutcome = {
    result: first,
    warnings: firstWarnings,
    firstWarnings,
    revised: false,
    revisionRejected: false,
    results: [first],
  };
  if (firstWarnings.length === 0 || opts.repair === false || !worthRepairing(firstWarnings)) return base;

  opts.onRepair?.(firstWarnings);
  const second = await (opts.repairProvider ?? provider).advise(
    repairRequest(req, first.text, firstWarnings),
    opts.signal,
    opts.onActivity,
  );
  const secondWarnings = warningsFor(second, check);
  const improved = secondWarnings.length < firstWarnings.length;

  return {
    result: improved ? second : first,
    warnings: improved ? secondWarnings : firstWarnings,
    firstWarnings,
    revised: true,
    revisionRejected: !improved,
    results: [first, second],
  };
}

/**
 * An unparseable plan is not a repairable warning: there is nothing to check
 * against, and the prose may be perfectly good. It degrades to text, exactly as
 * it did before the repair loop existed.
 */
function warningsFor(result: AdvisorResult, check: PlanCheckInput): PlanWarning[] {
  if (!result.structured) return [];
  return checkPlan(result.structured, check, { answer: result.text });
}

/** Total usage across every call a repair round made. */
export function totalUsage(results: readonly AdvisorResult[]): {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  thinkingTokens?: number;
} {
  const sum = results.reduce(
    (acc, r) => ({
      inputTokens: acc.inputTokens + (r.usage?.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (r.usage?.outputTokens ?? 0),
      costUsd: acc.costUsd + (r.usage?.costUsd ?? 0),
      thinkingTokens: acc.thinkingTokens + (r.usage?.thinkingTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, costUsd: 0, thinkingTokens: 0 },
  );
  // Only claimed when some call actually reported them: a zero would read as
  // "this run did no reasoning" / "this run was free" where the truth is "the
  // backend did not say" — which for cost is every codex-cli run, billed to the
  // subscription rather than priced per call.
  const { thinkingTokens, costUsd, ...rest } = sum;
  return {
    ...rest,
    ...(results.some((r) => r.usage?.costUsd !== undefined) ? { costUsd } : {}),
    ...(results.some((r) => r.usage?.thinkingTokens !== undefined) ? { thinkingTokens } : {}),
  };
}
