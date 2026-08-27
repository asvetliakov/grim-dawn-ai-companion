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
 *
 * **The call asks for an erratum, not a second answer.** Wall time is output
 * tokens — 83 to 87 a second on opus, in every one of twelve stored runs — so
 * "produce a corrected full answer, every section", which is what this used to
 * say, spent five minutes re-streaming an analysis to fix two lines. The plan
 * is the only thing the checks are decided against and the only thing a fix can
 * move, so that is all the model is asked for, and `spliceRevision` puts it
 * back under the prose the first call already paid for.
 *
 * The trade is real and accepted: a fix that changes a verdict can leave the
 * original prose arguing for the old one, which is why the erratum's own note
 * is kept and shown. A prose `ambiguous-stat` also survives a repair now, since
 * the prose is not rewritten — but a prose-only warning never buys a call in
 * the first place, so what survives is a passenger on a structural fix, never
 * the reason the call was made.
 */

import { answerProse, planBlock, replacePlanBlock } from '../../shared/answer.js';
import {
  parseAdvice,
  type ActivityListener,
  type AdvisorProvider,
  type AdvisorRequest,
  type AdvisorResult,
} from './provider.js';
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

/**
 * How the follow-up asks for a correction: an **erratum**, not a second answer.
 *
 * The call used to demand "a corrected full answer — every section", which on a
 * live run means re-streaming some twenty-eight thousand tokens to fix two
 * lines. Wall time is output tokens (measured at 83–87/s on opus across twelve
 * stored runs), so that phrasing is most of why a repaired run costs eleven
 * minutes instead of six. The plan is the only thing the checks are decided
 * against and the only thing a fix can move; the analysis is already written,
 * already correct about everything the checks did not name, and gets spliced
 * back on by `spliceRevision`.
 */
export function repairRequest(req: AdvisorRequest, answer: string, warnings: readonly PlanWarning[]): AdvisorRequest {
  const list = warnings.map((w) => `- [${w.kind}] ${w.message}`).join('\n');
  return {
    ...req,
    planOnly: true,
    question:
      `${req.question ? `${req.question}\n\n` : ''}` +
      'You have already answered this dossier once. Your previous answer is below, followed by the mechanical ' +
      'checks it failed. These checks are decided against the dossier, not opinions: an id that is not in the ' +
      'document does not exist, a use-on restriction is not negotiable, an extracted host is destroyed, and a ' +
      'bare damage-type name is ambiguous.\n\n' +
      '**Do not rewrite the analysis.** The tool keeps the prose you already wrote and splices your corrected ' +
      'plan onto it, so re-emitting those sections spends thousands of tokens on text that is thrown away. ' +
      'Reply with exactly two things and nothing else:\n\n' +
      '1. **What changed** — a few sentences naming which checks you fixed and how. If a check is wrong about ' +
      'the dossier, say so here in one line and leave that part of the plan as it was. This paragraph is shown ' +
      'to the reader under your original analysis.\n' +
      '2. The **corrected plan**, as one fenced json block and the final element of your reply. It must be ' +
      'complete and standalone — every field it carried before, not a diff — with exactly the checked faults ' +
      'fixed and every other conclusion kept.\n\n' +
      'The plan still has to agree with the analysis you already wrote, since the two are shown together. Where ' +
      'a fix genuinely contradicts something the prose argued, say so in **What changed**.\n\n' +
      `## Checks failed\n\n${list}\n\n## Your previous answer\n\n${answer}`,
  };
}

/**
 * The original's analysis, the erratum's note, and the erratum's plan.
 *
 * Two ways out, both deliberate. A reply with **no** plan block cannot be
 * spliced onto anything, so it stands as its own answer — which is also what a
 * refusal or an error message should look like. And a reply whose prose is
 * *longer* than the analysis it was correcting is a rewrite rather than an
 * erratum: the model ignored the instruction and answered afresh, so it is
 * taken whole, exactly as it was before this existed. That rule is what keeps
 * the change safe against a backend that will not follow the shorter contract —
 * the worst case is the old cost, not a mangled answer.
 */
export function spliceRevision(original: string, revision: string): string {
  const plan = planBlock(revision);
  if (!plan) return revision;

  const prose = answerProse(original).trimEnd();
  const note = answerProse(revision).trim();
  if (!prose || note.length >= prose.length) return revision;

  return replacePlanBlock(note ? `${prose}\n\n${note}` : prose, plan);
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
  const erratum = await (opts.repairProvider ?? provider).advise(
    repairRequest(req, first.text, firstWarnings),
    opts.signal,
    opts.onActivity,
  );

  // The answer to judge is the spliced one, so the checks run against exactly
  // what the user would be shown — the original argument carrying the corrected
  // plan. `structured` is re-parsed from the spliced text rather than carried
  // over from the erratum, because every check downstream joins the two and a
  // plan that disagreed with its own answer would be the one inconsistency
  // nothing here could catch.
  const text = spliceRevision(first.text, erratum.text);
  const second: AdvisorResult =
    text === erratum.text ? erratum : { ...erratum, text, structured: parseAdvice(text) };
  const secondWarnings = warningsFor(second, check);

  // A revision with no plan at all is not an improvement, however few warnings
  // can be counted against it. `warningsFor` reports nothing for an answer it
  // cannot parse — the right answer for a *first* call, which degrades to prose
  // — but here that reads as a perfect score and would hand the user a refusal
  // sentence in place of the plan they asked for. Only reachable when the first
  // call did produce a plan, since a run with no warnings never gets this far.
  const improved = second.structured !== undefined && secondWarnings.length < firstWarnings.length;

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
