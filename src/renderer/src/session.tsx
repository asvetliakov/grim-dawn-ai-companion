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

import type { AdviseEnvelope, AdvisePhase, Bootstrap, Settings, UiSnapshot } from '../../shared/ipc.js';

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

export interface SessionValue {
  bootstrap?: Bootstrap;
  snapshot?: UiSnapshot;
  /** The last advice run for the character on screen, if there is one. */
  advice?: AdviseEnvelope;
  /** Non-null while a run is in flight — including one this renderer did not start. */
  run: AdviseRun | null;
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
  const [run, setRun] = useState<AdviseRun | null>(null);
  const [adviceError, setAdviceError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<string>();
  const [error, setError] = useState<string>();
  /** Guards against a focus event landing on top of a load already in flight. */
  const inFlight = useRef(false);

  const load = useCallback(async (character?: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const next = await window.gd.getSnapshot(character);
      setSnapshot(next);
      setError(undefined);
      // Advice belongs to a character, so it is fetched with them rather than
      // carried across a character switch, where it would describe the wrong
      // loadout entirely.
      setAdvice((await window.gd.getLastAdvice(next.character)) ?? undefined);
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
        setAdviceError(undefined);
      } else if (event.type === 'advise-done') {
        setRun(null);
        setAdvice(event.envelope);
      } else if (event.type === 'advise-error') {
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
    startAdvice: (question?: string) => {
      void (async () => {
        setAdviceError(undefined);
        try {
          const { runId } = await window.gd.startAdvise(question ? { question } : {});
          // Optimistic, and superseded by the first push a moment later. Without
          // it the button would sit there looking unpressed for as long as the
          // context document takes to compile.
          setRun((prev) => prev ?? { runId, phase: 'context', startedAt: Date.now(), elapsedMs: 0 });
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
  if (adviceError) value.adviceError = adviceError;
  if (progress) value.progress = progress;
  if (error) value.error = error;

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
