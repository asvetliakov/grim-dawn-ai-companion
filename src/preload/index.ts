/**
 * The bridge, and the only thing the renderer can reach.
 *
 * `contextIsolation` plus `sandbox` mean the page has no `require`, no
 * `process`, and no way to invent a channel: it gets exactly the methods below,
 * each of which forwards to a channel the main process registered from the same
 * `IPC_CHANNELS` list. Adding a channel to the contract without wiring it here
 * fails to compile, because the object is typed as the whole `GdApi`.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import type { AdviseEnvelope, AdviseStatus, GdApi, PushEvent, Settings, UiSnapshot } from '../shared/ipc.js';
import { PUSH_CHANNEL } from '../shared/ipc.js';

const invoke = <T>(method: keyof GdApi, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(`gd:${method}`, ...args) as Promise<T>;

const api: GdApi = {
  getBootstrap: () => invoke('getBootstrap'),
  getSnapshot: (character?: string) => invoke<UiSnapshot>('getSnapshot', character),
  setActiveCharacter: (name: string) => invoke<void>('setActiveCharacter', name),
  updateSettings: (patch: Partial<Settings>) => invoke<Settings>('updateSettings', patch),
  refresh: () => invoke<UiSnapshot>('refresh'),
  startAdvise: (req: { question?: string }) => invoke<{ runId: string }>('startAdvise', req),
  cancelAdvise: (runId: string) => invoke<void>('cancelAdvise', runId),
  getAdviseStatus: () => invoke<AdviseStatus>('getAdviseStatus'),
  getLastAdvice: (character: string) => invoke<AdviseEnvelope | null>('getLastAdvice', character),
  onPush: (cb: (e: PushEvent) => void) => {
    const listener = (_event: IpcRendererEvent, payload: PushEvent): void => cb(payload);
    ipcRenderer.on(PUSH_CHANNEL, listener);
    return () => ipcRenderer.off(PUSH_CHANNEL, listener);
  },
};

contextBridge.exposeInMainWorld('gd', api);
