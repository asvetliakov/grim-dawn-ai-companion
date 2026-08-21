/**
 * Where the window was last time — `window.json`, beside `settings.json`.
 *
 * Deliberately **not** in `settings.json`. That file is choices the user made and
 * may reasonably hand-edit; this is state the window writes every time it is
 * dragged, and mixing the two would mean rewriting a hand-editable file dozens of
 * times a session and validating a schema against something nobody typed.
 *
 * Every read degrades to "nothing remembered": a `window.json` from an older
 * build, a truncated write, a file someone put a comment in — none of them is a
 * reason for the app not to open.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { appDataDir } from '../core/data-dir.js';
import { ensureDir } from '@grimdawn/core/db/cache';
import type { Bounds } from './window-size.js';

export interface WindowState {
  bounds?: Bounds;
  maximized?: boolean;
}

export function windowStatePath(): string {
  return join(appDataDir(), 'window.json');
}

export function readWindowState(): WindowState {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(windowStatePath(), 'utf8'));
  } catch {
    return {};
  }
  if (typeof raw !== 'object' || raw === null) return {};
  const record = raw as Record<string, unknown>;
  const state: WindowState = {};
  const bounds = record['bounds'];
  if (isBounds(bounds)) state.bounds = bounds;
  if (typeof record['maximized'] === 'boolean') state.maximized = record['maximized'];
  return state;
}

export function writeWindowState(state: WindowState): void {
  try {
    ensureDir(appDataDir());
    writeFileSync(windowStatePath(), `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    // A window position is not worth an error dialog, or a crash on a read-only
    // data directory.
  }
}

function isBounds(value: unknown): value is Bounds {
  if (typeof value !== 'object' || value === null) return false;
  const b = value as Record<string, unknown>;
  return (['x', 'y', 'width', 'height'] as const).every(
    (key) => typeof b[key] === 'number' && Number.isFinite(b[key]),
  );
}
