/**
 * Electron lifecycle — a thin consumer of `src/core`, exactly like the CLI.
 *
 * Nothing decided here is a domain decision: the window's job is to open, to
 * hand the renderer a locked-down bridge to the session, and to keep serving
 * `gdicon://` while it lives.
 */

import { join } from 'node:path';
import { app, BrowserWindow, clipboard, Menu, screen, session as electronSession, shell } from 'electron';

import { AdviseRunner } from './advise.js';
import { createApi, registerHandlers } from './ipc.js';
import { buildMenu, nameApp } from './menu.js';
import { handleIconProtocol, registerIconScheme } from './protocol.js';
import { SessionState } from './state.js';
import { MIN_SIZE, restoreBounds, startingSize } from './window-size.js';
import { readWindowState, writeWindowState } from './window-state.js';
import { APP_NAME, PUSH_CHANNEL, type PushEvent } from '../shared/ipc.js';

// Privileged schemes must be declared before the app is ready; after that the
// registration is silently ignored and every icon 404s. The name has the same
// deadline, for a different reason — see `nameApp`.
registerIconScheme();
nameApp();

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

/**
 * Always-on-top is a *setting*, so it is applied from the settings rather than
 * held as a second copy of the truth in the window — the menu checkbox, the
 * settings pane and a hand-edited `settings.json` all take the same road.
 */
function applyWindowPrefs(): void {
  const on = state.currentSettings().alwaysOnTop ?? false;
  window?.setAlwaysOnTop(on);
  installMenu();
}

function installMenu(): void {
  Menu.setApplicationMenu(
    buildMenu({
      window: () => window,
      send: broadcast,
      alwaysOnTop: () => state.currentSettings().alwaysOnTop ?? false,
      setAlwaysOnTop: (on) => {
        void state.updateSettings({ alwaysOnTop: on }).then(applyWindowPrefs);
      },
    }),
  );
}

function createWindow(): void {
  // Where it was last time, if that is still somewhere a window can be seen;
  // otherwise the largest of the design size the *work area* can hold — a
  // 1920×1080 monitor has already spent rows on the menu bar and the Dock.
  const work = screen.getPrimaryDisplay().workArea;
  const saved = readWindowState();
  const bounds = restoreBounds(saved.bounds, work);
  const { width, height } = bounds ?? startingSize(work);

  window = new BrowserWindow({
    width,
    height,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    // Centred rather than at the default offset: a window sized to the work
    // area and then placed at (x, y) can still hang off the bottom of it.
    center: bounds === undefined,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    backgroundColor: '#12100d',
    title: APP_NAME,
    alwaysOnTop: state.currentSettings().alwaysOnTop ?? false,
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

  if (saved.maximized) window.maximize();
  window.once('ready-to-show', () => window?.show());

  // Anything that wants to leave the app opens in the user's browser rather
  // than navigating the one window we have.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Geometry is saved on a timer rather than per event: a drag is hundreds of
  // `move`s, and each one would be a file write.
  let saveTimer: NodeJS.Timeout | undefined;
  const remember = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persistWindowState, 400);
  };
  window.on('resize', remember);
  window.on('move', remember);
  window.on('maximize', remember);
  window.on('unmaximize', remember);
  // And once more on the way out, because the last drag before a quit is
  // exactly the one a timer will not have flushed.
  window.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer);
    persistWindowState();
  });

  const devServer = process.env['ELECTRON_RENDERER_URL'];
  if (devServer) void window.loadURL(devServer);
  else void window.loadFile(join(__dirname, '../renderer/index.html'));

  window.on('closed', () => {
    window = undefined;
  });
}

function persistWindowState(): void {
  if (!window || window.isDestroyed()) return;
  const maximized = window.isMaximized();
  writeWindowState({
    // `getNormalBounds` is the size it would return to, which is what a restore
    // needs: saving the maximized bounds means un-maximizing to full screen.
    bounds: window.getNormalBounds(),
    maximized,
  });
}

void app.whenReady().then(() => {
  handleIconProtocol(electronSession.defaultSession, () => state.iconService());

  registerHandlers(
    createApi({
      getBootstrap: () => state.getBootstrap(),
      copyText: (text) => clipboard.writeText(text),
      getSnapshot: (character) => state.getSnapshot(character),
      setActiveCharacter: (name) => state.setActiveCharacter(name),
      updateSettings: async (patch) => {
        const settings = await state.updateSettings(patch);
        applyWindowPrefs();
        return settings;
      },
      refresh: () => state.refresh(),
      startAdvise: (req) => advisor.start(req),
      cancelAdvise: (runId) => advisor.cancel(runId),
      getAdviseStatus: () => advisor.status(),
      getAdviceHistory: (character) => advisor.history(character),
      getAdvice: (character, id) => advisor.advice(character, id),
      getContextDocument: () => state.contextDocument(),
      detectPaths: () => state.detectPaths(),
    }),
  );

  installMenu();
  createWindow();
  // Only once there is a window to push invalidations at.
  state.startWatching();

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
