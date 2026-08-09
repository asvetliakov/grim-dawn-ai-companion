/**
 * One advice run at a time, owned by the main process.
 *
 * The run lives here rather than in the renderer for a reason that is specific
 * to how long it takes: a real call is **~500 seconds**. Over eight minutes a
 * renderer can be reloaded, hot-replaced, or simply left behind by a window the
 * user resized into a busy frame — and every one of those would abandon a call
 * that is already being paid for. Started in main, the subprocess outlives all
 * of it, and a freshly-mounted renderer re-attaches through `status()`.
 *
 * Progress is **honest phases, elapsed time, and whatever the backend will tell
 * us — never a percentage.** There is still no way to know how far through an
 * opaque call is, so a bar would be an invention; the phases (`context` →
 * `asking` → `repair`) are the three things that genuinely happen and the clock
 * is real. What has changed since the first draft of this file is that the
 * backend turned out to have more to say: a streaming provider reports the
 * reasoning and the answer as they are written, which is the difference between
 * "asking the model" for ten silent minutes and watching it work through the
 * loadout. Coalesced here rather than forwarded raw — the deltas arrive dozens of
 * times a second, which is far more often than a panel can be read or repainted.
 *
 * A second `start` while one is live is refused rather than queued. Two
 * concurrent runs would cost two runs and, worse, the second would finish
 * against a document the first has already made stale.
 */

import { randomUUID } from 'node:crypto';

import {
  adviseWithRepair,
  buildEnvelope,
  createProvider,
  listAdvice,
  loadAdvice,
  normalizeName,
  saveAdvice,
  totalUsage,
  wornSlots,
  wornSocketables,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  type AdviceRunRef,
  type AdviseActivityState,
  type AdviseEnvelope,
  type AdviseStatus,
  type AdvisorActivity,
  type AdvisorProvider,
  type PlanCheckInput,
  type PlanWarning,
} from '../core/ai/index.js';
import { documentSocketables, type ContextDoc, type ContextInput } from '../core/context/builder.js';
import { shortHash } from '../core/resolve.js';
import { adviceScope, type CharacterSnapshot } from '../core/session.js';
import type { Settings } from '../core/settings-schema.js';
import type { PushEvent } from '../shared/ipc.js';

/** What the runner needs from the session, so it can be tested without one. */
export interface AdviseHost {
  characterSnapshot(): Promise<CharacterSnapshot>;
  gameVersion(): Promise<string>;
  currentSettings(): Settings;
  push(event: PushEvent): void;
  /**
   * How a provider is built. The same injectable seam the `claude-cli` provider
   * gives its `spawn` — and for the same reason: cancellation, a dead backend and
   * a run that survives a reload are all *timing*, and none of them can be tested
   * against a real eight-minute subprocess. Defaults to the configured one.
   */
  createProvider?: (settings: Settings) => AdvisorProvider;
}

/** Phases a run reports. `idle`/`done`/`error` are states, not steps. */
type RunPhase = 'context' | 'asking' | 'repair';

interface ActiveRun {
  runId: string;
  character: string;
  controller: AbortController;
  startedAt: number;
  phase: RunPhase;
  /** The live tail, when the provider streams. Absent until the first delta. */
  activity?: AdviseActivityState;
  /** Written but not yet pushed — the coalescing window's buffer. */
  pending: string;
  /** When a chunk was last pushed, for the coalescing below. */
  activityPushedAt: number;
}

export const ALREADY_RUNNING = 'An advice run is already in flight — cancel it before starting another.';

/**
 * How much of the model's current writing to keep *here*, for a window that
 * arrives late. A bound, so a twelve-minute run's memory is a constant.
 */
const ACTIVITY_TAIL = 600;

/** Coalescing window for activity pushes: four a second outruns any reader. */
const ACTIVITY_MS = 250;

export class AdviseRunner {
  private active: ActiveRun | null = null;
  /**
   * The last thing that went wrong, so a renderer that mounted *after* the
   * failure still learns about it. Without this a run that died while the window
   * was reloading would leave the panel idle with no explanation.
   */
  private lastError: { runId: string; message: string } | undefined;

  constructor(private readonly host: AdviseHost) {}

  /**
   * Kick a run off and return immediately.
   *
   * The promise resolves as soon as the run *exists*: the caller is an IPC
   * handler, and eight minutes is far past any sane invoke timeout. Everything
   * after that arrives as a push.
   */
  async start(req: { question?: string }): Promise<{ runId: string }> {
    if (this.active) throw new Error(ALREADY_RUNNING);

    const settings = this.host.currentSettings();
    const provider = (this.host.createProvider ?? configuredProvider)(settings);
    // A backend that cannot run should say so before a document is compiled for
    // it, and it should say so *in its own words* — "claude CLI not found on
    // PATH" is actionable where "not available" is not.
    if (!(await provider.available())) {
      throw new Error(await unavailableMessage(provider));
    }

    // The document has to exist before the run does, because the run is
    // identified by the character it is about.
    const snapshot = await this.host.characterSnapshot();
    const gameVersion = await this.host.gameVersion();
    // What the dossier covers is a stored preference, read at the moment the
    // run starts — the header checkbox writes it through `updateSettings`.
    const includeStash = settings.includeStashInAdvice ?? true;
    const scope = adviceScope(snapshot, includeStash);

    const run: ActiveRun = {
      runId: randomUUID(),
      character: snapshot.character,
      controller: new AbortController(),
      startedAt: Date.now(),
      phase: 'context',
      pending: '',
      activityPushedAt: 0,
    };
    this.active = run;
    this.lastError = undefined;
    this.report(run);

    // Deliberately not awaited: `start` answers the IPC call, and the run
    // reports itself from here on.
    void this.execute(run, provider, snapshot, scope, includeStash, gameVersion, req.question);
    return { runId: run.runId };
  }

  /**
   * Abort a run by id.
   *
   * By id rather than unconditionally, so a Cancel click that raced a completion
   * cannot kill the *next* run. An id that is not the live one is a no-op — the
   * user's intent has already been served.
   */
  cancel(runId: string): void {
    if (this.active?.runId === runId) this.active.controller.abort();
  }

  /** Enough for a renderer that has just mounted to re-attach to a live run. */
  status(): AdviseStatus {
    if (this.active) {
      return {
        phase: this.active.phase,
        runId: this.active.runId,
        character: this.active.character,
        elapsedMs: Date.now() - this.active.startedAt,
        ...(this.active.activity ? { activity: this.active.activity } : {}),
      };
    }
    if (this.lastError) return { phase: 'error', runId: this.lastError.runId, message: this.lastError.message };
    return { phase: 'idle' };
  }

  /**
   * Every stored run for a character, newest first — the picker's list.
   *
   * The only way in. There is no `lastAdvice` here any more and no `discard`: the
   * window opens on the empty state and a run is opened by being picked, and
   * nothing deletes one. Both were real methods with real channels, and both went
   * when the run controls stopped being "Clear" and "Re-run" — see `GdApi`.
   */
  history(character: string): AdviceRunRef[] {
    return listAdvice(character);
  }

  advice(character: string, id: string): AdviseEnvelope | null {
    return loadAdvice(character, id) ?? null;
  }

  private async execute(
    run: ActiveRun,
    provider: AdvisorProvider,
    snapshot: CharacterSnapshot,
    // The input/document pair the run actually sends — the snapshot's own when
    // the stash is included, a filtered rebuild when it is not. Everything below
    // reads from `scope`, never from `snapshot.doc`: the ids the envelope
    // carries must be the ids the model was shown.
    scope: { input: ContextInput; doc: ContextDoc },
    stashIncluded: boolean,
    gameVersion: string,
    question: string | undefined,
  ): Promise<void> {
    try {
      const check = planCheckInput(scope);
      this.advance(run, 'asking');

      const outcome = await adviseWithRepair(
        provider,
        { contextDoc: scope.doc.markdown, ...(question ? { question } : {}) },
        check,
        {
          signal: run.controller.signal,
          onRepair: (_warnings: readonly PlanWarning[]) => this.advance(run, 'repair'),
          onActivity: (activity) => this.observe(run, activity),
        },
      );

      const envelope = buildEnvelope({
        character: run.character,
        gameVersion,
        ...(question ? { question } : {}),
        outcome,
        usage: totalUsage(outcome.results),
        durationMs: Date.now() - run.startedAt,
        itemNames: Object.fromEntries([...scope.doc.itemsById].map(([id, item]) => [id, item.display])),
        socketableNames: Object.fromEntries([...scope.doc.socketablesById].map(([id, item]) => [id, item.name])),
        // What the run is about, so a stored answer can say whether it still is —
        // sockets included, because an item's id changes when its component does.
        worn: wornSlots(snapshot.resolved.items),
        wornSockets: wornSocketables(snapshot.resolved.items, shortHash),
        stashIncluded,
      });

      // Persisted *before* the push, so a renderer that reloads on the same
      // frame as the answer arriving still finds it on disk.
      saveAdvice(envelope);
      if (this.active?.runId === run.runId) this.active = null;
      this.host.push({ type: 'advise-done', runId: run.runId, envelope });
    } catch (err) {
      if (this.active?.runId === run.runId) this.active = null;
      const message = run.controller.signal.aborted ? 'Cancelled.' : (err as Error).message;
      this.lastError = { runId: run.runId, message };
      this.host.push({ type: 'advise-error', runId: run.runId, message });
    }
  }

  /**
   * Fold one delta into the run's tail, and push at most every `ACTIVITY_MS`.
   *
   * Two economies, both necessary. The tail is capped, so the memory a
   * twelve-minute run holds is bounded by a constant rather than by how much the
   * model wrote. And the push is throttled, because the deltas arrive faster than
   * a frame — forwarding each one would spend the whole run marshalling strings
   * across a process boundary faster than the panel could paint them.
   *
   * A change of `kind` pushes immediately: thinking giving way to the answer is
   * the one transition in a run that a reader is actually waiting for.
   */
  private observe(run: ActiveRun, activity: AdvisorActivity): void {
    if (this.active?.runId !== run.runId) return;
    const kindChanged = run.activity?.kind !== activity.kind;
    // Only the reasoning travels as text — the answer is about to be rendered
    // properly from the envelope, and streaming it through the transcript box
    // buried the reasoning under two copies of it (one per repair call). Its
    // deltas still flow for the token count and the kind flip.
    const delta = activity.kind === 'thinking' ? activity.text : '';
    // Two accumulations with different jobs. `pending` is what has not been sent
    // yet, so the renderer can append; `tail` is a bounded snapshot for a window
    // that mounts late and has nothing to append to.
    run.pending += delta;
    run.activity = {
      kind: activity.kind,
      tail: ((run.activity?.tail ?? '') + delta).slice(-ACTIVITY_TAIL),
      ...(activity.outputTokens !== undefined ? { outputTokens: activity.outputTokens } : {}),
    };

    const now = Date.now();
    if (!kindChanged && now - run.activityPushedAt < ACTIVITY_MS) return;
    run.activityPushedAt = now;
    const text = run.pending;
    run.pending = '';
    this.host.push({
      type: 'advise-activity',
      runId: run.runId,
      kind: activity.kind,
      text,
      ...(activity.outputTokens !== undefined ? { outputTokens: activity.outputTokens } : {}),
    });
  }

  private advance(run: ActiveRun, phase: RunPhase): void {
    run.phase = phase;
    this.report(run);
  }

  private report(run: ActiveRun): void {
    this.host.push({
      type: 'advise-progress',
      runId: run.runId,
      phase: run.phase,
      elapsedMs: Date.now() - run.startedAt,
    });
  }
}

/**
 * The provider a run uses, with model and effort **pinned** rather than
 * inherited: without both flags the `claude` subprocess picks up whatever the
 * user's interactive session or settings specify, and two runs on the same save
 * stop being comparable — which is the whole point of storing them.
 */
function configuredProvider(settings: Settings): AdvisorProvider {
  return createProvider(settings.provider, {
    model: settings.model ?? DEFAULT_MODEL,
    effort: settings.effort ?? DEFAULT_EFFORT,
    timeoutMs: (settings.advisorTimeoutSeconds ?? 0) * 1000 || DEFAULT_TIMEOUT_MS,
  });
}

/**
 * The same check input the CLI builds, so the window's runs are verified against
 * exactly what the document offered rather than against the whole database —
 * including which items §7 actually ranked, which is what the coverage check
 * measures a plan against.
 */
export function planCheckInput(scope: { input: ContextInput; doc: ContextDoc }): PlanCheckInput {
  return {
    itemsById: scope.doc.itemsById,
    socketables: new Map(documentSocketables(scope.input).map((item) => [normalizeName(item.name), item])),
    socketablesById: scope.doc.socketablesById,
    candidateIds: scope.doc.candidateIds,
  };
}

/**
 * Ask an unavailable provider to advise on nothing, purely to collect the
 * sentence it throws. The registered stubs and the `claude-cli` provider both
 * explain themselves that way, and repeating those explanations here would be a
 * second place for them to go stale.
 */
async function unavailableMessage(provider: { id: string; advise: (req: { contextDoc: string }) => Promise<unknown> }): Promise<string> {
  try {
    await provider.advise({ contextDoc: '' });
    return `Advisor ${JSON.stringify(provider.id)} is not available.`;
  } catch (err) {
    return (err as Error).message;
  }
}
