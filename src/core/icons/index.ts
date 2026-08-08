/**
 * Item icons, straight out of the game's own asset archives.
 *
 * Stage 3 gives every `DbItem` an `iconPath` copied from its DBR record — an
 * in-archive texture path such as `items/enchants/enchantm_black.tex`. This turns
 * that into a PNG on disk:
 *
 * ```
 *   items/enchants/enchantm_black.tex
 *     → resources/Items.arc, entry `enchants/enchantm_black.tex`   (first segment
 *       of the path names the archive; the rest is the entry)
 *     → 12-byte TEX wrapper → DDS → 32×64 BGRA pixels
 *     → cache/<fingerprint>/icons/items_enchants_enchantm_black.png
 * ```
 *
 * Archives are searched newest expansion first (`gdx3` → `gdx2` → `gdx1` → base),
 * the same last-wins order the `.arz` merge uses, so an expansion that re-arts a
 * base-game item wins here too.
 *
 * Everything is local: no network, and after the first request for an icon no
 * archive read either. Stage 7's `gdicon://` protocol handler is a thin wrapper
 * over `getIconPng` — sharp and friends never enter the picture, so nothing here
 * is off-limits to the Electron main process.
 */

import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ArcArchive } from '../db/arc.js';
import { buildCacheDir, ensureDir } from '../db/cache.js';
import {
  archivesFingerprint,
  findGameDir,
  gameArchives,
  MISSING_GAME_DIR_MESSAGE,
} from '../db/gamefiles.js';
import { encodePng } from './png.js';
import { decodeTex } from './tex.js';

/** Expansion roots, newest first — later content overrides earlier content. */
const ARCHIVE_ROOTS = ['gdx3', 'gdx2', 'gdx1', ''] as const;

export interface IconStats {
  /** Distinct icon paths asked for. */
  requested: number;
  /** Served from a PNG that was already on disk. */
  cached: number;
  /** Extracted from an archive and written this session. */
  decoded: number;
  /** No archive contains the texture — the record points at art that is gone. */
  missing: number;
  /** Found but not decodable; see `problems()`. */
  failed: number;
}

export interface IconService {
  /**
   * Absolute path to the icon's PNG, or undefined when the texture cannot be
   * produced. Undefined is an ordinary answer — the caller falls back to text —
   * and the reason is recorded in `problems()` rather than thrown.
   */
  getIconPng(iconPath: string): Promise<string | undefined>;
  /** Where the PNGs live; the UI serves this directory. */
  cacheDir: string;
  stats(): IconStats;
  /** icon path → why it produced nothing. */
  problems(): Map<string, string>;
  /** Release the archive file descriptors. */
  close(): void;
}

export interface IconServiceOptions {
  /** Defaults to auto-detection; see `findGameDir`. */
  gameDir?: string;
  /** Cache key for the game build; defaults to the one the database uses. */
  fingerprint?: string;
}

export function createIconService(opts: IconServiceOptions = {}): IconService {
  const gameDir = opts.gameDir ?? findGameDir();
  if (!gameDir) throw new Error(MISSING_GAME_DIR_MESSAGE);
  const fingerprint = opts.fingerprint ?? archivesFingerprint(gameArchives(gameDir));
  return new ArchiveIconService(gameDir, join(buildCacheDir(fingerprint), 'icons'));
}

class ArchiveIconService implements IconService {
  private readonly stat: IconStats = { requested: 0, cached: 0, decoded: 0, missing: 0, failed: 0 };
  private readonly issues = new Map<string, string>();
  /** Opened on first use and kept: only their tables are resident. */
  private readonly archives = new Map<string, ArcArchive[]>();
  private ensuredCacheDir = false;

  constructor(
    private readonly gameDir: string,
    readonly cacheDir: string,
  ) {}

  async getIconPng(iconPath: string): Promise<string | undefined> {
    this.stat.requested++;
    if (!iconPath) return this.fail(iconPath, 'the record names no icon', 'missing');

    const dest = join(this.cacheDir, flatten(iconPath));
    if (existsSync(dest)) {
      this.stat.cached++;
      return dest;
    }

    const slash = iconPath.indexOf('/');
    if (slash <= 0) return this.fail(iconPath, 'not an <archive>/<path> texture reference', 'missing');
    const archiveName = iconPath.slice(0, slash);
    const entryName = iconPath.slice(slash + 1);

    let raw: Buffer | undefined;
    for (const archive of this.archivesFor(archiveName)) {
      raw = archive.read(entryName);
      if (raw) break;
    }
    if (!raw) return this.fail(iconPath, `no ${archiveName}.arc contains ${entryName}`, 'missing');

    let png: Buffer;
    try {
      const { width, height, rgba } = decodeTex(raw);
      png = encodePng(width, height, rgba);
    } catch (err) {
      return this.fail(iconPath, (err as Error).message, 'failed');
    }

    if (!this.ensuredCacheDir) {
      ensureDir(this.cacheDir);
      this.ensuredCacheDir = true;
    }
    writeFileSync(dest, png);
    this.stat.decoded++;
    return dest;
  }

  stats(): IconStats {
    return { ...this.stat };
  }

  problems(): Map<string, string> {
    return new Map(this.issues);
  }

  close(): void {
    for (const list of this.archives.values()) for (const archive of list) archive.close();
    this.archives.clear();
  }

  private fail(iconPath: string, reason: string, kind: 'missing' | 'failed'): undefined {
    this.stat[kind]++;
    this.issues.set(iconPath, reason);
    return undefined;
  }

  /**
   * Every `<name>.arc` under the install's `resources` directories, newest
   * expansion first. The match is case-insensitive because the paths inside the
   * records (`ui/...`) and the archive filenames (`UI.arc`) disagree on case.
   */
  private archivesFor(name: string): ArcArchive[] {
    const cached = this.archives.get(name.toLowerCase());
    if (cached) return cached;

    const opened: ArcArchive[] = [];
    for (const root of ARCHIVE_ROOTS) {
      const dir = join(this.gameDir, root, 'resources');
      let files: string[];
      try {
        files = readdirSync(dir);
      } catch {
        continue; // an expansion the user does not own
      }
      const file = files.find((f) => f.toLowerCase() === `${name.toLowerCase()}.arc`);
      if (!file) continue;
      try {
        opened.push(ArcArchive.open(join(dir, file)));
      } catch (err) {
        // A corrupt or unexpected archive should cost us that archive, not every
        // icon in the game.
        this.issues.set(join(dir, file), (err as Error).message);
      }
    }
    this.archives.set(name.toLowerCase(), opened);
    return opened;
  }
}

/**
 * `items/enchants/enchantm_black.tex` → `items_enchants_enchantm_black.png`.
 *
 * Flat rather than nested so the cache directory can be served as one place, and
 * because collapsing the separators makes a record path that escapes the cache
 * directory unrepresentable.
 */
export function flatten(iconPath: string): string {
  return `${iconPath.replace(/\.tex$/i, '').replace(/[^A-Za-z0-9._-]+/g, '_')}.png`;
}

export type { DecodedTexture } from './tex.js';
export { decodeTex, UnsupportedTextureError } from './tex.js';
export { encodePng } from './png.js';
