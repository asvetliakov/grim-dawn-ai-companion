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
 * Progress is **honest phases plus elapsed time, and nothing else**. There is no
 * token stream to read and no way to know how far through an opaque subprocess
 * is, so a percentage would be an invention; the phases (`context` → `asking` →
 * `repair`) are the three things that genuinely happen, and the clock is real.
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
  loadLastAdvice,
  normalizeName,
  saveLastAdvice,
  totalUsage,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  type AdviseEnvelope,
  type AdviseStatus,
  type AdvisorProvider,
  type PlanCheckInput,
  type PlanWarning,
} from '../core/ai/index.js';
import { documentSocketables } from '../core/context/builder.js';
import type { CharacterSnapshot } from '../core/session.js';
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
}

export const ALREADY_RUNNING = 'An advice run is already in flight — cancel it before starting another.';

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

    const run: ActiveRun = {
      runId: randomUUID(),
      character: snapshot.character,
      controller: new AbortController(),
      startedAt: Date.now(),
      phase: 'context',
    };
    this.active = run;
    this.lastError = undefined;
    this.report(run);

    // Deliberately not awaited: `start` answers the IPC call, and the run
    // reports itself from here on.
    void this.execute(run, provider, snapshot, gameVersion, req.question);
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
      };
    }
    if (this.lastError) return { phase: 'error', runId: this.lastError.runId, message: this.lastError.message };
    return { phase: 'idle' };
  }

  lastAdvice(character: string): AdviseEnvelope | null {
    return loadLastAdvice(character) ?? null;
  }

  private async execute(
    run: ActiveRun,
    provider: AdvisorProvider,
    snapshot: CharacterSnapshot,
    gameVersion: string,
    question: string | undefined,
  ): Promise<void> {
    try {
      const check = planCheckInput(snapshot);
      this.advance(run, 'asking');

      const outcome = await adviseWithRepair(
        provider,
        { contextDoc: snapshot.doc.markdown, ...(question ? { question } : {}) },
        check,
        {
          signal: run.controller.signal,
          onRepair: (_warnings: readonly PlanWarning[]) => this.advance(run, 'repair'),
        },
      );

      const envelope = buildEnvelope({
        character: run.character,
        gameVersion,
        ...(question ? { question } : {}),
        outcome,
        usage: totalUsage(outcome.results),
        durationMs: Date.now() - run.startedAt,
        itemNames: Object.fromEntries([...snapshot.doc.itemsById].map(([id, item]) => [id, item.display])),
        socketableNames: Object.fromEntries([...snapshot.doc.socketablesById].map(([id, item]) => [id, item.name])),
      });

      // Persisted *before* the push, so a renderer that reloads on the same
      // frame as the answer arriving still finds it on disk.
      saveLastAdvice(envelope);
      if (this.active?.runId === run.runId) this.active = null;
      this.host.push({ type: 'advise-done', runId: run.runId, envelope });
    } catch (err) {
      if (this.active?.runId === run.runId) this.active = null;
      const message = run.controller.signal.aborted ? 'Cancelled.' : (err as Error).message;
      this.lastError = { runId: run.runId, message };
      this.host.push({ type: 'advise-error', runId: run.runId, message });
    }
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
 * exactly what the document offered rather than against the whole database.
 */
export function planCheckInput(snapshot: CharacterSnapshot): PlanCheckInput {
  return {
    itemsById: snapshot.doc.itemsById,
    socketables: new Map(documentSocketables(snapshot.input).map((item) => [normalizeName(item.name), item])),
    socketablesById: snapshot.doc.socketablesById,
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
