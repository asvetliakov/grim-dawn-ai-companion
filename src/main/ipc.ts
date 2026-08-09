/**
 * Channel registration.
 *
 * `registerHandlers` takes the whole `GdApi` and walks `IPC_CHANNELS`, so a
 * channel added to the contract and forgotten here is a compile error rather
 * than a promise that never resolves.
 *
 * The advise half is a thin forward to the run manager. It stays thin on
 * purpose: an IPC handler answers in milliseconds, and the ~500-second run it
 * starts reports itself through pushes — see `advise.ts` for why the run lives
 * in main rather than in the renderer.
 */

import { ipcMain } from 'electron';

import type { AdviceRunRef, AdviseEnvelope, AdviseStatus } from '../core/ai/envelope.js';
import type { Settings } from '../core/settings-schema.js';
import type { UiSnapshot } from '../shared/view.js';
import { IPC_CHANNELS, type ContextDocumentView, type DetectedPaths, type GdApi } from '../shared/ipc.js';

/** Channel name as sent over IPC — namespaced so nothing else can collide. */
export function channelName(method: string): string {
  return `gd:${method}`;
}

/** The whole API over one session, with the advise run manager behind it. */
export function createApi(impl: {
  getBootstrap: GdApi['getBootstrap'];
  getSnapshot: (character?: string) => Promise<UiSnapshot>;
  setActiveCharacter: (name: string) => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<Settings>;
  refresh: () => Promise<UiSnapshot>;
  startAdvise: (req: { question?: string }) => Promise<{ runId: string }>;
  cancelAdvise: (runId: string) => void;
  getAdviseStatus: () => AdviseStatus;
  getAdviceHistory: (character: string) => AdviceRunRef[];
  getAdvice: (character: string, id: string) => AdviseEnvelope | null;
  getContextDocument: () => Promise<ContextDocumentView>;
  detectPaths: () => DetectedPaths;
}): Omit<GdApi, 'onPush'> {
  return {
    ...impl,
    // The synchronous ones are wrapped here rather than declared async in the
    // runner: reading a file and reading a field are not asynchronous, and
    // pretending otherwise there would hide that from the run manager's tests.
    cancelAdvise: async (runId: string) => impl.cancelAdvise(runId),
    getAdviseStatus: async () => impl.getAdviseStatus(),
    getAdviceHistory: async (character: string) => impl.getAdviceHistory(character),
    getAdvice: async (character: string, id: string) => impl.getAdvice(character, id),
    detectPaths: async () => impl.detectPaths(),
  };
}

export function registerHandlers(api: Omit<GdApi, 'onPush'>): void {
  for (const channel of IPC_CHANNELS) {
    ipcMain.handle(channelName(channel), async (_event, ...args: unknown[]) => {
      // The cast is the one unavoidable seam: `ipcMain` hands us `unknown[]`,
      // and the contract's per-channel argument types are what the preload
      // enforces on the way in.
      const fn = api[channel] as (...a: unknown[]) => Promise<unknown>;
      return fn(...args);
    });
  }
}
