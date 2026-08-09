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

import type { AdviseEnvelope, Bootstrap, Settings, UiSnapshot } from '../../shared/ipc.js';

export interface SessionValue {
  bootstrap?: Bootstrap;
  snapshot?: UiSnapshot;
  /**
   * The last advice run for the character on screen, if there is one. Stage 7A
   * always gets null back — the channel is registered and stubbed — so the
   * loadout's proposal column renders locked until 7B fills it in.
   */
  advice?: AdviseEnvelope;
  loading: boolean;
  /** The database build's own progress notes — a first boot takes real time. */
  progress?: string;
  error?: string;
  refresh: () => void;
  setCharacter: (name: string) => void;
  updateSettings: (patch: Partial<Settings>) => void;
}

const SessionContext = createContext<SessionValue | undefined>(undefined);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession outside a SessionProvider');
  return value;
}

export function SessionProvider({ children }: { children: ReactNode }): ReactNode {
  const [bootstrap, setBootstrap] = useState<Bootstrap>();
  const [snapshot, setSnapshot] = useState<UiSnapshot>();
  const [advice, setAdvice] = useState<AdviseEnvelope>();
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
      setError((err as Error).message.replace(/^Error invoking remote method '[^']*': /, ''));
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
    });
  }, [load]);

  // Standing in for Stage 7C's file watcher: coming back to the window is the
  // moment a stale character screen is most obvious.
  useEffect(() => {
    const onFocus = (): void => void load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const value: SessionValue = {
    loading,
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
  if (progress) value.progress = progress;
  if (error) value.error = error;

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
