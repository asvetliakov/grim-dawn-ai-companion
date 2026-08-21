/**
 * This app's own data directory: `~/Library/Application Support/gd-ai-companion/`.
 *
 * ```
 *   settings.json
 *   window.json                   geometry, written on every drag
 *   advice/<character>/*.json     stored advice runs
 * ```
 *
 * Deliberately *not* where the game database cache lives. That cache is keyed by
 * a fingerprint of the install's archives, costs half a minute to build and says
 * nothing about which app asked for it, so it sits under a shared root
 * (`defaultCacheRoot` in `db/cache.ts`) that a sibling tool can hit warm. What is
 * left here is what this app chose or wrote, and nothing else has any business
 * reading it.
 *
 * `GD_DATA_DIR` exists so tests can run against a throwaway directory. It steers
 * the cache too — one variable isolates an entire run.
 *
 * The directory was `gd-companion` before the app was named, and the old one is
 * deliberately **not** read or moved: everything in it is either a preference
 * worth setting again in a pane that now exists, or a cache that rebuilds itself
 * from the install in half a minute. Migrating a pre-1.0 cache is a code path
 * that would be wrong exactly once and never exercised again.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export function appDataDir(): string {
  return process.env.GD_DATA_DIR ?? join(homedir(), 'Library/Application Support/gd-ai-companion');
}
