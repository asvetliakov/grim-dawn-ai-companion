/**
 * Loading the game database.
 *
 * Two sources, one interface:
 *
 *  - the game's own files supply item identity — the DBR record path, which is
 *    the only thing saves store and the only thing that can be joined back to
 *    them — plus the installed game's version;
 *  - GrimTools supplies exactly one thing: the tag → text localization table.
 *
 * First run parses the archives and downloads the localization; every run after
 * that reads one `db.json` and touches neither. `--refresh` forces both again.
 */

import {
  archivesFingerprint,
  findGameDir,
  gameArchives,
  readGameVersion,
  MISSING_GAME_DIR_MESSAGE,
} from './gamefiles.js';
import { buildDb, cleanText, readGameRecords, type NormalizedDb } from './build.js';
import {
  clearCachedBuild,
  readCachedDb,
  readCachedRaw,
  writeCachedDb,
  writeCachedRaw,
} from './cache.js';
import { download, l10nUrl, parseL10n } from './grimtools.js';
import { REP_TIERS, type DbFaction, type DbItem, type DbRecipe, type DbStats, type GameDb, type RepTier } from './types.js';

export interface LoadDbOptions {
  /** Defaults to auto-detection; see `findGameDir`. */
  gameDir?: string;
  locale?: string;
  /** Re-download and rebuild even when a cache exists. */
  refresh?: boolean;
  /** Called with progress notes; the CLI prints them, the UI can show them. */
  onProgress?: (message: string) => void;
}

export async function loadGameDb(opts: LoadDbOptions = {}): Promise<GameDb> {
  return new NormalizedGameDb(await loadNormalizedDb(opts));
}

export async function loadNormalizedDb(opts: LoadDbOptions = {}): Promise<NormalizedDb> {
  const locale = opts.locale ?? 'en';
  const note = opts.onProgress ?? (() => {});

  const gameDir = opts.gameDir ?? findGameDir();
  if (!gameDir) throw new Error(MISSING_GAME_DIR_MESSAGE);

  const archives = gameArchives(gameDir);
  const fingerprint = archivesFingerprint(archives);

  if (opts.refresh) clearCachedBuild(fingerprint);
  else {
    const cached = readCachedDb(fingerprint);
    if (cached) {
      note(`database ${cached.gameVersion} loaded from cache (${fingerprint})`);
      return cached;
    }
  }

  note(`reading ${archives.length} archive(s) from ${gameDir}`);
  const game = readGameRecords(archives);
  note(`${game.records.size} records`);

  const l10n = await loadLocalization(fingerprint, locale, opts.refresh === true, note);

  const db = buildDb({
    game,
    l10n,
    gameVersion: readGameVersion(gameDir) ?? 'unknown',
    fingerprint,
    archives: archives.map((a) => a.expansion),
  });
  writeCachedDb(db);
  note(`database built: ${Object.keys(db.items).length} items`);
  return db;
}

/**
 * The one thing we still fetch. The raw download is cached alongside `db.json`,
 * so a rebuild after e.g. a schema bump costs no network either — only a new
 * game build (or `--refresh`) goes back out to grimtools.com.
 */
async function loadLocalization(
  fingerprint: string,
  locale: string,
  refresh: boolean,
  note: (message: string) => void,
): Promise<Record<string, string>> {
  const name = `l10n-${locale}.js`;

  let src = refresh ? undefined : readCachedRaw(fingerprint, name);
  if (src === undefined) {
    note(`downloading ${l10nUrl(locale)}`);
    src = await download(l10nUrl(locale));
    writeCachedRaw(fingerprint, name, src);
  }
  return parseL10n(src, locale);
}

/** `GameDb` over the cached JSON — every lookup is a plain object read. */
export class NormalizedGameDb implements GameDb {
  constructor(private readonly db: NormalizedDb) {}

  get gameVersion(): string {
    return this.db.gameVersion;
  }

  get raw(): NormalizedDb {
    return this.db;
  }

  getItem(record: string): DbItem | undefined {
    return this.db.items[record];
  }

  getAffixName(record: string): string | undefined {
    return this.db.affixes[record] || undefined;
  }

  knowsAffix(record: string): boolean {
    return record in this.db.affixes;
  }

  factions(): DbFaction[] {
    return this.db.factions;
  }

  vendorItems(factionId: string, maxTier: RepTier): DbItem[] {
    const tiers = this.db.vendor[factionId];
    if (!tiers) return [];
    const cutoff = REP_TIERS.indexOf(maxTier);
    const seen = new Set<string>();
    const out: DbItem[] = [];
    for (const tier of REP_TIERS.slice(0, cutoff + 1)) {
      for (const record of tiers[tier] ?? []) {
        if (seen.has(record)) continue;
        seen.add(record);
        const item = this.db.items[record];
        if (item) out.push(item);
      }
    }
    return out;
  }

  recipes(): DbRecipe[] {
    return this.db.recipes;
  }

  /** Unknown tags come back as themselves — visibly wrong beats silently blank. */
  localize(tag: string): string {
    const text = this.db.l10n[tag];
    return text === undefined ? tag : cleanText(text);
  }

  stats(): DbStats {
    const vendorFactions = Object.keys(this.db.vendor);
    const vendorItems = new Set(
      vendorFactions.flatMap((id) => REP_TIERS.flatMap((tier) => this.db.vendor[id]?.[tier] ?? [])),
    );
    return {
      gameVersion: this.db.gameVersion,
      fingerprint: this.db.fingerprint,
      builtAt: this.db.builtAt,
      archives: this.db.archives,
      items: Object.keys(this.db.items).length,
      affixes: Object.keys(this.db.affixes).length,
      namedAffixes: Object.values(this.db.affixes).filter((n) => n !== '').length,
      localizedNames: this.db.localizedNames,
      l10nTags: Object.keys(this.db.l10n).length,
      factions: this.db.factions.length,
      vendorFactions: vendorFactions.length,
      vendorItems: vendorItems.size,
      recipes: this.db.recipes.length,
    };
  }
}

export * from './types.js';
