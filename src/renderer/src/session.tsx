/**
 * One window, one character, one snapshot — held in plain React state.
 *
 * The snapshot is replaced wholesale on every refresh rather than patched: it
 * is built in one pass in the main process, a refresh costs one save parse, and
 * a diffing store would buy nothing but a second place for the two to disagree.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type {
  AdviceRunRef,
  AdviseActivityState,
  AdviseEnvelope,
  AdvisePhase,
  Bootstrap,
  Settings,
  UiSnapshot,
} from '../../shared/ipc.js';

/**
 * The run in flight, as the window needs to describe it.
 *
 * `elapsedMs` is ticked here rather than pushed from main. Main *does* send it
 * with every phase change, but there are only three of those in eight minutes —
 * a clock that moves three times is worse than no clock, because it reads as a
 * frozen app. `startedAt` comes from main (directly, or as
 * `now - status.elapsedMs` when re-attaching), so the number is still the run's
 * real age and not the age of this renderer.
 */
export interface AdviseRun {
  runId: string;
  phase: AdvisePhase;
  startedAt: number;
  elapsedMs: number;
}

/**
 * Everything the model has written this run, when the backend streams it.
 *
 * Held **beside** the run rather than on it, and deliberately outliving it: the
 * reasoning is worth reading after the answer arrives, and a field on `run` would
 * vanish the moment the run ended. Cleared when the next run starts, because two
 * runs' reasoning concatenated is nobody's transcript.
 *
 * Accumulated here from the deltas main pushes, not fetched: see the note on
 * `advise-activity`. Consequence worth stating — a window that mounts *during* a
 * run gets the bounded tail from `status()` and not the transcript, because
 * nothing was keeping the whole of it on this side. That is honest and cheap;
 * keeping every run's full reasoning in main against the chance of a reload is
 * neither.
 */
export interface RunActivity {
  kind: 'thinking' | 'answer';
  text: string;
  outputTokens?: number;
  /** True when this began as a late re-attach, so the start of it is missing. */
  partial?: boolean;
}

export interface SessionValue {
  bootstrap?: Bootstrap;
  snapshot?: UiSnapshot;
  /** The advice run on screen — the newest stored one, or one picked from history. */
  advice?: AdviseEnvelope;
  /** Every stored run for this character, newest first. */
  adviceHistory: AdviceRunRef[];
  /** Which of them is on screen, so the picker can show its own selection. */
  adviceId?: string;
  /** Non-null while a run is in flight — including one this renderer did not start. */
  run: AdviseRun | null;
  /** What the model has written, live and then afterwards. See `RunActivity`. */
  activity?: RunActivity;
  /** What the last run failed with, cleared when another starts. */
  adviceError?: string;
  loading: boolean;
  /** The database build's own progress notes — a first boot takes real time. */
  progress?: string;
  error?: string;
  refresh: () => void;
  setCharacter: (name: string) => void;
  updateSettings: (patch: Partial<Settings>) => void;
  startAdvice: (question?: string) => void;
  cancelAdvice: () => void;
  /** Show a stored run. */
  selectAdvice: (id: string) => void;
  /**
   * Put the run on screen away and go back to the empty state, where a new one
   * can be started.
   *
   * **Selects nothing; deletes nothing.** This replaced a `Clear` that deleted the
   * run it was next to, and the two are worth telling apart: the destructive
   * reading made the one control a user reaches for after acting on a plan — "I
   * have done these, ask me again" — the one control that could throw a
   * four-dollar answer away. The run stays in `adviceHistory` and can be reopened.
   */
  newRun: () => void;
}

const SessionContext = createContext<SessionValue | undefined>(undefined);

/**
 * A rejected `invoke` arrives wrapped in Electron's own framing. The main
 * process wrote a sentence for the user; the channel name in front of it is
 * noise to everyone but a developer.
 */
function ipcMessage(err: unknown): string {
  return (err as Error).message.replace(/^Error invoking remote method '[^']*': /, '');
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession outside a SessionProvider');
  return value;
}

export function SessionProvider({ children }: { children: ReactNode }): ReactNode {
  const [bootstrap, setBootstrap] = useState<Bootstrap>();
  const [snapshot, setSnapshot] = useState<UiSnapshot>();
  const [advice, setAdvice] = useState<AdviseEnvelope>();
  const [history, setHistory] = useState<AdviceRunRef[]>([]);
  const [adviceId, setAdviceId] = useState<string>();
  const [run, setRun] = useState<AdviseRun | null>(null);
  const [activity, setActivity] = useState<RunActivity>();
  const [adviceError, setAdviceError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<string>();
  const [error, setError] = useState<string>();
  /** Guards against a focus event landing on top of a load already in flight. */
  const inFlight = useRef(false);
  /**
   * Runs that have already pushed `done` or `error`, so the optimistic set in
   * `startAdvice` cannot resurrect one. Electron does not order an `invoke`
   * reply against `send` pushes, and a mock-fast run really does finish before
   * `startAdvise` resolves — without this the stale "it started" state arrived
   * *after* the real "it finished" one and stuck a phantom run on screen.
   */
  const endedRuns = useRef(new Set<string>());
  /**
   * Whose save was read last, so a re-read can tell a refresh from a switch.
   *
   * A ref rather than the `snapshot` state because `load` is a stable callback and
   * must stay one — it is wired to the focus event and to Stage 7C's watcher, and a
   * `load` that changed identity on every snapshot would re-subscribe both.
   */
  const readCharacter = useRef<string | undefined>(undefined);

  const load = useCallback(async (character?: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const next = await window.gd.getSnapshot(character);
      setSnapshot(next);
      setError(undefined);
      // Advice belongs to a character, so the history is fetched with them rather
      // than carried across a switch, where it would list runs about another
      // character's loadout entirely.
      const runs = await window.gd.getAdviceHistory(next.character);
      setHistory(runs);
      /*
       * Which run is on screen is the reader's choice, and a re-read is not one.
       *
       * So this opens nothing — the window starts empty and a run is opened from
       * the picker — and equally closes nothing: `load` runs on every window focus
       * (and will run on Stage 7C's watcher), and a refresh that dropped the open
       * plan would take the marks off the gear every time the user came back from
       * the game, which is the exact moment they are comparing the two.
       *
       * A *different character* is the one case where it must go: the ids would
       * join onto another loadout, and the verdicts would be about slots that are
       * not on screen.
       */
      if (readCharacter.current !== next.character) {
        readCharacter.current = next.character;
        setAdvice(undefined);
        setAdviceId(undefined);
        setActivity(undefined);
      }
    } catch (err) {
      // The message is the main process's own — a missing install, a save the
      // game is mid-write on. Showing it beats a spinner that never stops.
      setError(ipcMessage(err));
    } finally {
      inFlight.current = false;
      setLoading(false);
      setProgress(undefined);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const boot = await window.gd.getBootstrap();
        if (cancelled) return;
        setBootstrap(boot);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
      if (!cancelled) await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    return window.gd.onPush((event) => {
      if (event.type === 'db-progress') setProgress(event.message);
      else if (event.type === 'snapshot-invalidated') void load();
      else if (event.type === 'advise-progress') {
        // `startedAt` is derived from the elapsed time main reports rather than
        // from the moment this push arrived: a renderer that mounted six minutes
        // into a run must show six minutes, not zero.
        setRun({
          runId: event.runId,
          phase: event.phase,
          startedAt: Date.now() - event.elapsedMs,
          elapsedMs: event.elapsedMs,
        });
        // The repair call reasons afresh, and its reasoning lands in the same
        // box: without a seam the two read as one argument that mysteriously
        // starts over. Pushed exactly once — `advance` fires per transition.
        if (event.phase === 'repair') {
          setActivity((prev) =>
            prev ? { ...prev, kind: 'thinking', text: `${prev.text}\n\n— revising the plan —\n\n` } : prev,
          );
        }
        setAdviceError(undefined);
      } else if (event.type === 'advise-activity') {
        // Appended, because the push is a delta — and only the reasoning is.
        // The answer's text is not accumulated: the panel renders the finished
        // answer properly the moment it arrives, and streaming it through this
        // box buried the one thing that exists nowhere else (see `ActivityLog`).
        // Its progress still shows, as the token count.
        setActivity((prev) => ({
          kind: event.kind,
          text: (prev?.text ?? '') + (event.kind === 'thinking' ? event.text : ''),
          ...(event.outputTokens !== undefined
            ? { outputTokens: event.outputTokens }
            : prev?.outputTokens !== undefined
              ? { outputTokens: prev.outputTokens }
              : {}),
          ...(prev?.partial ? { partial: true } : {}),
        }));
      } else if (event.type === 'advise-done') {
        endedRuns.current.add(event.runId);
        setRun(null);
        setAdvice(event.envelope);
        // A finished run joins the history and becomes the selection.
        void (async () => {
          const runs = await window.gd.getAdviceHistory(event.envelope.character);
          setHistory(runs);
          setAdviceId(runs[0]?.id);
        })();
      } else if (event.type === 'advise-error') {
        endedRuns.current.add(event.runId);
        setRun(null);
        setAdviceError(event.message);
      }
    });
  }, [load]);

  /**
   * Re-attach on mount.
   *
   * A reload during an eight-minute call is not exotic — it is what happens on
   * every hot module replacement in development, and on any renderer crash in
   * production. The run itself is in the main process, so all that is needed is
   * to ask what it is doing.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const status = await window.gd.getAdviseStatus();
      if (cancelled) return;
      if (status.runId && (status.phase === 'context' || status.phase === 'asking' || status.phase === 'repair')) {
        setRun({
          runId: status.runId,
          phase: status.phase,
          startedAt: Date.now() - (status.elapsedMs ?? 0),
          elapsedMs: status.elapsedMs ?? 0,
        });
        // Seeded from the bounded tail: this window was not here for the rest of
        // it, and it says so rather than presenting a fragment as the whole.
        if (status.activity) {
          setActivity({
            kind: status.activity.kind,
            text: status.activity.tail,
            partial: true,
            ...(status.activity.outputTokens !== undefined ? { outputTokens: status.activity.outputTokens } : {}),
          });
        }
      } else if (status.phase === 'error' && status.message) {
        setAdviceError(status.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The clock. One second is the right resolution for a number in the hundreds,
  // and the interval only exists while there is something to count. It depends on
  // *whether* a run is in flight, not on the run — otherwise every tick would
  // tear the interval down and build another one.
  const running = run !== null;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      setRun((prev) => (prev ? { ...prev, elapsedMs: Date.now() - prev.startedAt } : prev));
    }, 1000);
    return () => clearInterval(timer);
  }, [running]);

  // Standing in for Stage 7C's file watcher: coming back to the window is the
  // moment a stale character screen is most obvious.
  useEffect(() => {
    const onFocus = (): void => void load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const value: SessionValue = {
    loading,
    run,
    adviceHistory: history,
    selectAdvice: (id: string) => {
      void (async () => {
        if (!snapshot) return;
        const envelope = await window.gd.getAdvice(snapshot.character, id);
        if (!envelope) return;
        setAdvice(envelope);
        setAdviceId(id);
      })();
    },
    newRun: () => {
      // Nothing is fetched and nothing is written: the whole action is to stop
      // showing a stored run. The transcript goes with it — it belongs to that run
      // and would otherwise sit above a Run button as if it were this one's.
      setAdvice(undefined);
      setAdviceId(undefined);
      setActivity(undefined);
      setAdviceError(undefined);
    },
    startAdvice: (question?: string) => {
      void (async () => {
        setAdviceError(undefined);
        // A new run's reasoning is its own; the previous run's would read as a
        // preamble to it.
        setActivity(undefined);
        try {
          const { runId } = await window.gd.startAdvise(question ? { question } : {});
          // Optimistic, and superseded by the first push a moment later. Without
          // it the button would sit there looking unpressed for as long as the
          // context document takes to compile. Skipped for a run that already
          // ended — see `endedRuns`: the reply can arrive after the pushes.
          setRun((prev) =>
            prev ?? (endedRuns.current.has(runId) ? null : { runId, phase: 'context', startedAt: Date.now(), elapsedMs: 0 }),
          );
        } catch (err) {
          // A refused start is the readable half of this feature: no `claude` on
          // PATH, or a run already in flight. Both belong in the panel.
          setAdviceError(ipcMessage(err));
        }
      })();
    },
    cancelAdvice: () => {
      if (!run) return;
      void window.gd.cancelAdvise(run.runId).catch((err: unknown) => setAdviceError(ipcMessage(err)));
    },
    refresh: () => {
      void (async () => {
        try {
          const next = await window.gd.refresh();
          setSnapshot(next);
          setError(undefined);
        } catch (err) {
          setError((err as Error).message);
        }
      })();
    },
    setCharacter: (name: string) => {
      void (async () => {
        await window.gd.setActiveCharacter(name);
        setBootstrap((prev) => (prev ? { ...prev, active: name } : prev));
      })();
    },
    updateSettings: (patch: Partial<Settings>) => {
      void (async () => {
        const settings = await window.gd.updateSettings(patch);
        setBootstrap((prev) => (prev ? { ...prev, settings } : prev));
      })();
    },
  };
  if (bootstrap) value.bootstrap = bootstrap;
  if (snapshot) value.snapshot = snapshot;
  if (advice) value.advice = advice;
  if (activity) value.activity = activity;
  if (adviceId) value.adviceId = adviceId;
  if (adviceError) value.adviceError = adviceError;
  if (progress) value.progress = progress;
  if (error) value.error = error;

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
