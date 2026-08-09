/**
 * Channel registration.
 *
 * `registerHandlers` takes the whole `GdApi` and walks `IPC_CHANNELS`, so a
 * channel added to the contract and forgotten here is a compile error rather
 * than a promise that never resolves. The advise channels are registered now
 * and answer honestly that they are not implemented yet — Stage 7B replaces the
 * implementation, not the wiring.
 */

import { ipcMain } from 'electron';

import type { AdviseEnvelope, AdviseStatus } from '../core/ai/envelope.js';
import type { Settings } from '../core/settings-schema.js';
import type { UiSnapshot } from '../shared/view.js';
import { IPC_CHANNELS, type GdApi } from '../shared/ipc.js';

/** Channel name as sent over IPC — namespaced so nothing else can collide. */
export function channelName(method: string): string {
  return `gd:${method}`;
}

const NOT_YET = 'AI advice arrives in Stage 7B.';

/**
 * The read-only half of the API, over one session. The advise half is stubbed
 * so the contract is complete and the renderer can already render a disabled
 * button rather than pretending the feature does not exist.
 */
export function createApi(impl: {
  getBootstrap: GdApi['getBootstrap'];
  getSnapshot: (character?: string) => Promise<UiSnapshot>;
  setActiveCharacter: (name: string) => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<Settings>;
  refresh: () => Promise<UiSnapshot>;
}): Omit<GdApi, 'onPush'> {
  return {
    ...impl,
    startAdvise: async () => {
      throw new Error(NOT_YET);
    },
    cancelAdvise: async () => {
      throw new Error(NOT_YET);
    },
    getAdviseStatus: async (): Promise<AdviseStatus> => ({ phase: 'idle', message: NOT_YET }),
    getLastAdvice: async (): Promise<AdviseEnvelope | null> => null,
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
