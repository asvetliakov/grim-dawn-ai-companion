/**
 * Loading the game database.
 *
 * One source: the installed game. Its `.arz` archives supply item identity — the
 * DBR record path, which is the only thing saves store and the only thing that
 * can be joined back to them — its `Text_<LOCALE>.arc` archives supply the names,
 * and `Engine.dll` supplies the version. Nothing is fetched, so the tool works
 * offline and always describes the build that is actually installed.
 *
 * First run parses the archives; every run after that reads one `db.json`.
 * `--refresh` forces the parse again.
 */

import {
  archivesFingerprint,
  findGameDir,
  gameArchives,
  readGameVersion,
  MISSING_GAME_DIR_MESSAGE,
} from './gamefiles.js';
import { buildDb, cleanText, readGameRecords, type NormalizedDb } from './build.js';
import { clearCachedBuild, readCachedDb, writeCachedDb } from './cache.js';
import { DEFAULT_LOCALE, availableLocales, readGameText } from './gametext.js';
import {
  REP_TIERS,
  type DbAffix,
  type DbFaction,
  type DbItem,
  type DbRecipe,
  type DbSet,
  type DbSkill,
  type DbStats,
  type GameDb,
  type RepTier,
  type LevelProgression,
  type SpeedCaps,
  type BaseSpeeds,
  type CombatFormulas,
} from './types.js';

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
  const locale = opts.locale ?? DEFAULT_LOCALE;
  const note = opts.onProgress ?? (() => {});

  const gameDir = opts.gameDir ?? findGameDir();
  if (!gameDir) throw new Error(MISSING_GAME_DIR_MESSAGE);

  const archives = gameArchives(gameDir);
  const fingerprint = archivesFingerprint(archives);

  if (opts.refresh) clearCachedBuild(fingerprint);
  else {
    const cached = readCachedDb(fingerprint, locale);
    if (cached) {
      note(`database ${cached.gameVersion} loaded from cache (${fingerprint}, ${locale})`);
      return cached;
    }
  }

  note(`reading ${archives.length} archive(s) from ${gameDir}`);
  const game = readGameRecords(archives);
  note(`${game.records.size} records`);

  const l10n = readGameText(gameDir, locale, archives);
  note(`${Object.keys(l10n).length} localized tags (${locale})`);

  const db = buildDb({
    game,
    l10n,
    gameVersion: readGameVersion(gameDir) ?? 'unknown',
    locale,
    locales: availableLocales(gameDir),
    fingerprint,
    archives: archives.map((a) => a.expansion),
  });
  writeCachedDb(db);
  note(`database built: ${Object.keys(db.items).length} items`);
  return db;
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
    return this.db.affixes[record]?.name;
  }

  knowsAffix(record: string): boolean {
    return record in this.db.affixes;
  }

  getAffix(record: string): DbAffix | undefined {
    return this.db.affixes[record];
  }

  getSkill(record: string): DbSkill | undefined {
    return this.db.skills[record];
  }

  getSet(record: string): DbSet | undefined {
    return this.db.sets[record];
  }

  skillName(record: string): string | undefined {
    return this.db.skillNames[record]?.[0] || undefined;
  }

  skillClass(record: string): string | undefined {
    return this.db.skillNames[record]?.[1] || this.db.skills[record]?.class;
  }

  difficultyPenalty(difficulty: string): Record<string, number> {
    return this.db.difficultyPenalty[difficulty] ?? {};
  }

  armorAbsorptionBase(): number {
    return this.db.armorAbsorptionBase;
  }

  speedCaps(): SpeedCaps {
    return this.db.speedCaps;
  }

  combatFormulas(): CombatFormulas {
    return this.db.combatFormulas;
  }

  baseSpeeds(): BaseSpeeds {
    return this.db.baseSpeeds;
  }

  levelProgression(): LevelProgression {
    return this.db.levelProgression;
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
      locale: this.db.locale,
      locales: this.db.locales,
      fingerprint: this.db.fingerprint,
      builtAt: this.db.builtAt,
      archives: this.db.archives,
      items: Object.keys(this.db.items).length,
      affixes: Object.keys(this.db.affixes).length,
      namedAffixes: Object.values(this.db.affixes).filter((a) => a.name).length,
      localizedNames: this.db.localizedNames,
      l10nTags: Object.keys(this.db.l10n).length,
      factions: this.db.factions.length,
      vendorFactions: vendorFactions.length,
      vendorItems: vendorItems.size,
      recipes: this.db.recipes.length,
      skills: Object.keys(this.db.skills).length,
      skillNames: Object.keys(this.db.skillNames).length,
      sets: Object.keys(this.db.sets).length,
      itemsWithAttrReq: Object.values(this.db.items).filter((i) => i.attrReq).length,
      socketables: Object.values(this.db.items).filter((i) => i.allowedSlots).length,
    };
  }
}

export * from './types.js';
