/**
 * The application menu — which on macOS is also how the app says its own name.
 *
 * Without one, Electron installs a default template built around the *binary's*
 * identity, so a development run reads `Electron` in the menu bar next to the
 * Apple logo and every keyboard shortcut belongs to a sample app. `app.setName`
 * fixes what the first submenu is called; this file is what puts the app's own
 * commands under it.
 *
 * The two panes live in the renderer, so their menu items are pushes rather than
 * calls: nothing is being asked for, the window is being asked to open something.
 */

import { Menu, app, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';

import { APP_NAME, type PushEvent } from '../shared/ipc.js';

export interface MenuDeps {
  /** The window to act on — looked up lazily, since it outlives no reload. */
  window: () => BrowserWindow | undefined;
  send: (event: PushEvent) => void;
  alwaysOnTop: () => boolean;
  setAlwaysOnTop: (on: boolean) => void;
}

export function buildMenu(deps: MenuDeps): Menu {
  const isMac = process.platform === 'darwin';

  /**
   * `role: 'appMenu'` is load-bearing on macOS, not decoration.
   *
   * Without it Electron does not recognise this as *the* application menu, so it
   * prepends a default one of its own and demotes ours to a second menu — which
   * is how the bar ended up reading `Grim Dawn AI Companion | File | Edit | …`
   * with the app's own Settings item hidden in the `File` menu. With the role,
   * this submenu replaces the default and the bar's first title is `app.getName()`.
   */
  const appMenu: MenuItemConstructorOptions = {
    role: 'appMenu',
    // Ignored on macOS, where the first submenu is always titled with
    // `app.getName()` — and used verbatim everywhere else.
    label: APP_NAME,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      {
        label: 'Settings…',
        accelerator: 'CmdOrCtrl+,',
        click: () => deps.send({ type: 'open-pane', pane: 'settings' }),
      },
      { type: 'separator' },
      ...(isMac
        ? ([
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
          ] as const)
        : []),
      { role: 'quit' },
    ],
  };

  const view: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      {
        // The debug affordance the difficulty override is verified through:
        // "what did the model actually see" in one click.
        label: 'Context document…',
        accelerator: 'CmdOrCtrl+D',
        click: () => deps.send({ type: 'open-pane', pane: 'context' }),
      },
      { type: 'separator' },
      {
        label: 'Always on top',
        type: 'checkbox',
        checked: deps.alwaysOnTop(),
        click: (item) => deps.setAlwaysOnTop(item.checked),
      },
      { type: 'separator' },
      { role: 'reload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };

  const window: MenuItemConstructorOptions = {
    label: 'Window',
    submenu: isMac
      ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
      : [{ role: 'minimize' }, { role: 'close' }],
  };

  const help: MenuItemConstructorOptions = {
    role: 'help',
    submenu: [
      {
        label: 'Game data © Crate Entertainment',
        click: () => void shell.openExternal('https://www.grimdawn.com/'),
      },
    ],
  };

  return Menu.buildFromTemplate([
    ...(isMac ? [appMenu] : [{ ...appMenu, label: 'File' }]),
    { role: 'editMenu' },
    view,
    window,
    help,
  ]);
}

/**
 * Name the app before anything reads the name.
 *
 * `app.setName` has to run before `ready`, and it is what the About box, the
 * macOS menu bar and `process.title` all come from. In a packaged build the
 * bundle's `CFBundleName` says the same thing; in development this is the only
 * thing standing between the user and a menu bar that says `Electron`.
 */
export function nameApp(): void {
  app.setName(APP_NAME);
}
