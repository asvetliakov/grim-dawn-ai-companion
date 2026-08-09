/**
 * Where a Windows game ends up on whatever machine this is running on.
 *
 * Grim Dawn is a Windows game with no native macOS or Linux build, so *every*
 * install — Steam or GOG — sits under something shaped like a `C:\` drive. What
 * differs is what is wrapped around it: a CrossOver or Whisky bottle here, a
 * Proton prefix on Linux, and on Windows nothing at all. Rather than spell out a
 * dozen full paths, this module answers three questions the two finders compose
 * from:
 *
 *   - **`windowsRoots()`** — every `drive_c`-alike on this machine.
 *   - **`steamRoots()`** — every directory holding `steamapps` and `userdata`,
 *     including Steam libraries on other drives (`libraryfolders.vdf`).
 *   - **`documentRoots()`** — every `Documents` folder a `My Games/Grim Dawn/save`
 *     could hang off, which is where **GOG** and cloud-off Steam keep saves.
 *
 * Nothing here is specific to the store: a GOG copy under CrossOver is a
 * `drive_c/GOG Games/Grim Dawn` beside a `drive_c/users/<user>/Documents`, and
 * both fall out of the roots above.
 *
 * Every lookup is `existsSync` and `readdirSync` over a handful of directories,
 * all guarded, so an unreadable path is an empty list rather than a crash. The
 * environment overrides (`GD_GAME_DIR`, `GD_SAVE_DIR`) still win over all of it.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/** Grim Dawn's Steam app id — its `userdata` and `compatdata` subdirectory. */
export const STEAM_APP_ID = '219990';

export function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** `dir/*` for every child that exists, or nothing if `dir` does not. */
function children(dir: string): string[] {
  return safeReaddir(dir).map((name) => join(dir, name));
}

const isWindows = platform() === 'win32';
const isMac = platform() === 'darwin';

/**
 * Every `C:\` this machine has.
 *
 * On Windows those are real drive letters — scanned rather than assumed, because
 * a 200 GB Steam library on `D:` is the normal case, not the exotic one. On macOS
 * they are the bottles of the two wrappers people actually run Grim Dawn under
 * (CrossOver, Whisky) plus a bare Wine prefix. On Linux, Wine and the Proton
 * prefix Steam makes for this specific app id.
 */
export function windowsRoots(): string[] {
  if (isWindows) {
    const roots: string[] = [];
    for (let code = 'C'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
      const drive = `${String.fromCharCode(code)}:\\`;
      if (existsSync(drive)) roots.push(drive);
    }
    return roots;
  }

  const roots: string[] = [];
  if (isMac) {
    for (const bottle of children(join(homedir(), 'Library/Application Support/CrossOver/Bottles'))) {
      roots.push(join(bottle, 'drive_c'));
    }
    for (const bottle of children(
      join(homedir(), 'Library/Containers/com.isaacmarovitz.Whisky/Bottles'),
    )) {
      roots.push(join(bottle, 'drive_c'));
    }
  }
  roots.push(join(homedir(), '.wine/drive_c'));
  for (const steam of [join(homedir(), '.steam/steam'), join(homedir(), '.local/share/Steam')]) {
    roots.push(join(steam, 'steamapps/compatdata', STEAM_APP_ID, 'pfx/drive_c'));
  }
  return roots.filter((root) => existsSync(root));
}

/**
 * Steam roots: the directories that hold `steamapps` and `userdata`.
 *
 * The second half is `libraryfolders.vdf`, Steam's own list of the extra library
 * directories the user has added. Only the `"path"` values are read out of it —
 * a regex rather than a VDF parser, because that one key is all this needs and a
 * malformed file should cost nothing.
 *
 * Note the asymmetry the caller has to live with: a *library* holds
 * `steamapps/common` but never `userdata`, which only ever lives under the Steam
 * install itself.
 */
export function steamRoots(): string[] {
  const roots: string[] = [];
  for (const root of windowsRoots()) {
    roots.push(join(root, 'Program Files (x86)/Steam'), join(root, 'Program Files/Steam'));
  }
  if (isMac) roots.push(join(homedir(), 'Library/Application Support/Steam'));
  roots.push(join(homedir(), '.steam/steam'), join(homedir(), '.local/share/Steam'));

  const found = roots.filter((root) => existsSync(join(root, 'steamapps')) || existsSync(join(root, 'userdata')));
  return [...new Set([...found, ...found.flatMap(extraLibraries)])];
}

function extraLibraries(steamRoot: string): string[] {
  const vdf = join(steamRoot, 'steamapps/libraryfolders.vdf');
  let text: string;
  try {
    text = readFileSync(vdf, 'utf8');
  } catch {
    return [];
  }
  const paths: string[] = [];
  for (const match of text.matchAll(/"path"\s+"([^"]+)"/g)) {
    // The file escapes Windows separators; `join` does not care which way they
    // lean, but a literal `\\` in the middle of a path does.
    const path = match[1]!.replace(/\\\\/g, '\\');
    if (existsSync(path)) paths.push(path);
  }
  return paths;
}

/**
 * Every `Documents` a `My Games/Grim Dawn/save` could hang off — which is where
 * **GOG** keeps its saves, and where Steam keeps them with cloud saves off.
 *
 * OneDrive is in the list because Windows redirects `Documents` into it by
 * default on a machine signed into a Microsoft account, and a tool that only
 * looked at `%USERPROFILE%\Documents` would find nothing on a very ordinary
 * setup.
 *
 * The native macOS `~/Documents` is deliberately **absent**: nothing puts a
 * Windows game's saves there, and it is TCC-protected, so reaching for it buys a
 * permission prompt in exchange for a directory that cannot contain what we are
 * looking for.
 */
export function documentRoots(): string[] {
  const roots: string[] = [];
  if (isWindows) {
    const profile = process.env['USERPROFILE'] ?? homedir();
    roots.push(join(profile, 'Documents'), join(profile, 'OneDrive/Documents'));
  }
  for (const root of windowsRoots()) {
    for (const user of children(join(root, 'users'))) {
      roots.push(join(user, 'Documents'), join(user, 'OneDrive/Documents'));
    }
  }
  return roots.filter((root) => existsSync(root));
}
