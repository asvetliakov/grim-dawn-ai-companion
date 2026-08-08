/**
 * The tool's own data directory.
 *
 * Layout under `~/Library/Application Support/gd-companion/`:
 *
 * ```
 *   settings.json
 *   cache/<fingerprint>/          one directory per game build
 *     l10n-en.js                  raw GrimTools download, kept for reproducibility
 *     itemdb.js                   ditto
 *     db.json                     normalized database — the fast startup path
 * ```
 *
 * The directory is keyed by a fingerprint of the game's `.arz` archives rather
 * than by version string, because the fingerprint is derivable offline: a cold
 * start with a warm cache never has to ask the network what version it is.
 * `db.json` records the human-readable `gameVersion` inside itself.
 *
 * Nothing here is ever committed — it is all game-derived data.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { DB_SCHEMA_VERSION, type NormalizedDb } from './build.js';

/** `GD_DATA_DIR` exists so tests can run against a throwaway directory. */
export function appDataDir(): string {
  return process.env.GD_DATA_DIR ?? join(homedir(), 'Library/Application Support/gd-companion');
}

export function cacheRoot(): string {
  return join(appDataDir(), 'cache');
}

export function buildCacheDir(fingerprint: string): string {
  return join(cacheRoot(), fingerprint);
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function rawPath(fingerprint: string, name: string): string {
  return join(buildCacheDir(fingerprint), name);
}

export function readCachedRaw(fingerprint: string, name: string): string | undefined {
  const path = rawPath(fingerprint, name);
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

export function writeCachedRaw(fingerprint: string, name: string, contents: string): void {
  ensureDir(buildCacheDir(fingerprint));
  writeFileSync(rawPath(fingerprint, name), contents);
}

export function dbPath(fingerprint: string): string {
  return join(buildCacheDir(fingerprint), 'db.json');
}

/**
 * Load the normalized database for a game build, or undefined if it is absent or
 * stale. A cache written by an older schema is treated as absent rather than
 * migrated — it costs a couple of seconds to rebuild and cannot be misread.
 */
export function readCachedDb(fingerprint: string): NormalizedDb | undefined {
  const path = dbPath(fingerprint);
  if (!existsSync(path)) return undefined;
  try {
    const db = JSON.parse(readFileSync(path, 'utf8')) as NormalizedDb;
    if (db.schemaVersion !== DB_SCHEMA_VERSION) return undefined;
    return db;
  } catch {
    // A half-written cache (interrupted build) reads as no cache.
    return undefined;
  }
}

export function writeCachedDb(db: NormalizedDb): void {
  ensureDir(buildCacheDir(db.fingerprint));
  writeFileSync(dbPath(db.fingerprint), JSON.stringify(db));
}

/** Drop a build's cache directory — what `db --refresh` does before rebuilding. */
export function clearCachedBuild(fingerprint: string): void {
  rmSync(buildCacheDir(fingerprint), { recursive: true, force: true });
}
