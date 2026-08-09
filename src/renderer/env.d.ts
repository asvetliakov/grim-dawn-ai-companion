import type { GdApi } from '../shared/ipc.js';

declare global {
  interface Window {
    /** The preload bridge. Present in the Electron window and nowhere else. */
    gd: GdApi;
  }
}
