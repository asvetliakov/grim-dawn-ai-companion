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
 */

import type { AdvisorProvider, AdvisorRequest, AdvisorResult } from './provider.js';
import { checkPlan, type PlanCheckInput, type PlanWarning } from './verify.js';

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
  signal?: AbortSignal;
  /** Called before the second request, so a CLI can say what it is doing. */
  onRepair?: (warnings: readonly PlanWarning[]) => void;
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
  const first = await provider.advise(req, opts.signal);
  const firstWarnings = warningsFor(first, check);

  const base: RepairOutcome = {
    result: first,
    warnings: firstWarnings,
    firstWarnings,
    revised: false,
    revisionRejected: false,
    results: [first],
  };
  if (firstWarnings.length === 0 || opts.repair === false) return base;

  opts.onRepair?.(firstWarnings);
  const second = await provider.advise(repairRequest(req, first.text, firstWarnings), opts.signal);
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
  costUsd: number;
} {
  return results.reduce(
    (sum, r) => ({
      inputTokens: sum.inputTokens + (r.usage?.inputTokens ?? 0),
      outputTokens: sum.outputTokens + (r.usage?.outputTokens ?? 0),
      costUsd: sum.costUsd + (r.usage?.costUsd ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  );
}
