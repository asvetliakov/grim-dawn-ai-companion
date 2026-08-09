/**
 * Electron lifecycle — a thin consumer of `src/core`, exactly like the CLI.
 *
 * Nothing decided here is a domain decision: the window's job is to open, to
 * hand the renderer a locked-down bridge to the session, and to keep serving
 * `gdicon://` while it lives.
 */

import { join } from 'node:path';
import { app, BrowserWindow, screen, session as electronSession, shell } from 'electron';

import { AdviseRunner } from './advise.js';
import { createApi, registerHandlers } from './ipc.js';
import { handleIconProtocol, registerIconScheme } from './protocol.js';
import { SessionState } from './state.js';
import { MIN_SIZE, startingSize } from './window-size.js';
import { PUSH_CHANNEL, type PushEvent } from '../shared/ipc.js';

// Privileged schemes must be declared before the app is ready; after that the
// registration is silently ignored and every icon 404s.
registerIconScheme();

let window: BrowserWindow | undefined;

function broadcast(event: PushEvent): void {
  if (window && !window.isDestroyed()) window.webContents.send(PUSH_CHANNEL, event);
}

const state = new SessionState(broadcast);
const advisor = new AdviseRunner({
  characterSnapshot: () => state.characterSnapshot(),
  gameVersion: () => state.gameVersion(),
  currentSettings: () => state.currentSettings(),
  push: broadcast,
});

function createWindow(): void {
  // The screen decides how much of the design size actually fits: a 1920×1080
  // monitor has already spent rows on the menu bar and the Dock.
  const { width, height } = startingSize(screen.getPrimaryDisplay().workAreaSize);
  window = new BrowserWindow({
    width,
    height,
    // Centred rather than at the default offset: a window sized to the work
    // area and then placed at (x, y) can still hang off the bottom of it.
    center: true,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    backgroundColor: '#12100d',
    title: 'Grim Dawn Companion',
    webPreferences: {
      // CommonJS on purpose: an ESM preload requires `sandbox: false`, and the
      // sandbox is worth more than the module syntax. `__dirname` is real here
      // for the same reason — see `electron.vite.config.ts`.
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.once('ready-to-show', () => window?.show());

  // Anything that wants to leave the app opens in the user's browser rather
  // than navigating the one window we have.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devServer = process.env['ELECTRON_RENDERER_URL'];
  if (devServer) void window.loadURL(devServer);
  else void window.loadFile(join(__dirname, '../renderer/index.html'));

  window.on('closed', () => {
    window = undefined;
  });
}

void app.whenReady().then(() => {
  handleIconProtocol(electronSession.defaultSession, () => state.iconService());

  registerHandlers(
    createApi({
      getBootstrap: () => state.getBootstrap(),
      getSnapshot: (character) => state.getSnapshot(character),
      setActiveCharacter: (name) => state.setActiveCharacter(name),
      updateSettings: (patch) => state.updateSettings(patch),
      refresh: () => state.refresh(),
      startAdvise: (req) => advisor.start(req),
      cancelAdvise: (runId) => advisor.cancel(runId),
      getAdviseStatus: () => advisor.status(),
      getLastAdvice: (character) => advisor.lastAdvice(character),
    }),
  );

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  state.dispose();
  // macOS convention is to stay in the dock, but this is a single-window
  // utility with nothing to do without a window.
  app.quit();
});
