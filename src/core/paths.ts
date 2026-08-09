/**
 * Where Grim Dawn keeps its saves on this machine.
 *
 * The game runs under CrossOver, so the "Windows" userdata tree lives inside the
 * Steam bottle. This is the Steam Cloud userdata path — the authoritative one;
 * the `~/Documents/My Games` location some guides mention is neither used here
 * nor reachable (TCC-protected for the shell).
 *
 * Stage 3 replaces the hardcoded default with a settings file; `GD_SAVE_DIR`
 * already overrides it today, which is what makes these parsers testable on
 * another machine.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_SAVE_DIR = join(
  homedir(),
  'Library/Application Support/CrossOver/Bottles/Steam/drive_c',
  'Program Files (x86)/Steam/userdata/42909985/219990/remote/save',
);

/** Root of the save tree: contains `main/<character>/` plus the shared `.gst` files. */
export function saveDir(): string {
  return process.env.GD_SAVE_DIR ?? DEFAULT_SAVE_DIR;
}

export function characterSavePath(character: string, dir = saveDir()): string {
  return join(dir, 'main', character, 'player.gdc');
}

/** Shared (softcore) transfer stash. Hardcore's `.gsh` twin is out of scope for now. */
export function transferStashPath(dir = saveDir()): string {
  return join(dir, 'transfer.gst');
}

/** Account-wide learned blueprints. */
export function formulasPath(dir = saveDir()): string {
  return join(dir, 'formulas.gst');
}

/**
 * Account-wide crafting materials **and loose components**. Every component not
 * installed in a piece of gear lives here rather than in a bag, which is why a
 * tool that never opened this file reported the user owning almost none.
 */
export function reagentsPath(dir = saveDir()): string {
  return join(dir, 'reagents.gst');
}

/** The potion recipe list. Same format as `reagents.gst`, no quantities. */
export function potionsPath(dir = saveDir()): string {
  return join(dir, 'potions.gst');
}
