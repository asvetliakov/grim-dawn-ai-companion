import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { DbItem, GameDb } from '../src/core/db/types.js';
import { CoverageTracker, resolveCharacter, resolveItem } from '../src/core/resolve.js';
import { parseGdc } from '../src/core/save/gdc.js';
import { parseFormulasFile, parseTransferStash } from '../src/core/save/gst.js';
import type { ItemInstance } from '../src/core/save/types.js';
import {
  CHARACTERS,
  FORMULAS_PATH,
  MISSING_GAME_MESSAGE,
  MISSING_SAVES_MESSAGE,
  TRANSFER_STASH_PATH,
  gameDb,
  haveFormulas,
  haveGameInstall,
  haveSaves,
  haveTransferStash,
  snapshotCharacterSave,
  snapshotSharedSave,
} from './paths.js';

// ---------------------------------------------------------------------------
// A stub database, so the naming rules are testable without the game installed
// ---------------------------------------------------------------------------

function dbItem(record: string, name: string, extra: Partial<DbItem> = {}): DbItem {
  return { record, name, levelReq: 1, rarity: 'Common', slot: 'x', iconPath: '', stats: {}, ...extra };
}

function stubDb(items: Record<string, DbItem>, affixes: Record<string, string>): GameDb {
  return {
    gameVersion: 'test',
    getItem: (record) => items[record],
    getAffixName: (record) => affixes[record] || undefined,
    knowsAffix: (record) => record in affixes,
    getAffix: (record) =>
      record in affixes
        ? { record, stats: {}, ...(affixes[record] ? { name: affixes[record]! } : {}) }
        : undefined,
    getSkill: () => undefined,
    getSet: () => undefined,
    skillName: () => undefined,
    difficultyPenalty: () => ({}),
    armorAbsorptionBase: () => 70,
    factions: () => [],
    vendorItems: () => [],
    recipes: () => [],
    localize: (tag) => tag,
    stats: () => {
      throw new Error('not needed');
    },
  };
}

function instance(over: Partial<ItemInstance> = {}): ItemInstance {
  return {
    baseName: '',
    prefixName: '',
    suffixName: '',
    modifierName: '',
    transmuteName: '',
    seed: 0,
    relicName: '',
    relicBonus: '',
    relicSeed: 0,
    augmentName: '',
    unknown: 0,
    augmentSeed: 0,
    relicCompletionLevel: 0,
    stackCount: 1,
    unknownExtra: [0, 0, 0, 0],
    ...over,
  };
}

describe('resolveItem', () => {
  const BASE = 'records/items/gearweapons/blunt1h/b005e_blunt.dbr';
  const PREFIX = 'records/items/lootaffixes/prefix/ao004b_cold_08.dbr';
  const SUFFIX = 'records/items/lootaffixes/suffix/a014b_ch_speedattack_03_je.dbr';
  const COMPONENT = 'records/items/materia/compa_soulshard.dbr';

  const db = stubDb(
    {
      [BASE]: dbItem(BASE, 'Legion Warhammer', { rarity: 'Rare', levelReq: 40 }),
      [COMPONENT]: dbItem(COMPONENT, 'Soul Shard'),
    },
    { [PREFIX]: 'Thunderstruck', [SUFFIX]: 'of Alacrity' },
  );

  it('builds a prefix + base + suffix display name', () => {
    const item = resolveItem(
      instance({ baseName: BASE, prefixName: PREFIX, suffixName: SUFFIX, relicName: COMPONENT }),
      db,
      'equipped',
      'Weapon set 1 main',
    );
    expect(item.display).toBe('Thunderstruck Legion Warhammer of Alacrity');
    expect(item.base?.rarity).toBe('Rare');
    expect(item.component?.name).toBe('Soul Shard');
    expect(item.unresolved).toEqual([]);
  });

  it('omits affixes an item does not have', () => {
    const item = resolveItem(instance({ baseName: BASE }), db, 'stash', 'tab 1 (0,0)');
    expect(item.display).toBe('Legion Warhammer');
    expect(item.prefixName).toBeUndefined();
  });

  it('falls back to the record stem and records the miss', () => {
    const unknown = 'records/items/gearhead/z999_head.dbr';
    const item = resolveItem(instance({ baseName: unknown }), db, 'inventory', 'bag 1 (0,0)');
    expect(item.display).toBe('z999_head');
    expect(item.base).toBeUndefined();
    expect(item.unresolved).toEqual([unknown]);
  });

  it('counts a nameless crafting affix as resolved, not as a miss', () => {
    const crafting = 'records/items/lootaffixes/crafting/ao306_poison.dbr';
    const withCrafting = stubDb({ [BASE]: dbItem(BASE, 'Legion Warhammer') }, { [crafting]: '' });
    const track = new CoverageTracker();
    const item = resolveItem(
      instance({ baseName: BASE, prefixName: crafting }),
      withCrafting,
      'stash',
      'tab 1 (0,0)',
      track,
    );
    expect(item.display).toBe('Legion Warhammer');
    expect(item.unresolved).toEqual([]);

    const coverage = track.report();
    expect(coverage.affixResolved).toBe(1);
    expect(coverage.affixMissing).toEqual([]);
    expect(coverage.affixUnnamed).toEqual([crafting]);
  });
});

describe('CoverageTracker', () => {
  it('counts distinct records, so the same item twice is one record', () => {
    const track = new CoverageTracker();
    track.base('records/a.dbr', true);
    track.base('records/a.dbr', true);
    track.base('records/b.dbr', false);
    const report = track.report();
    expect(report.baseTotal).toBe(2);
    expect(report.baseResolved).toBe(1);
    expect(report.baseMissing).toEqual(['records/b.dbr']);
  });

  it('ignores the empty record the save uses for "no item"', () => {
    const track = new CoverageTracker();
    track.base('', false);
    track.affix('', false);
    expect(track.report().baseTotal).toBe(0);
    expect(track.report().affixTotal).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The gate: real saves against the real database
// ---------------------------------------------------------------------------

const canRunLive = haveGameInstall() && haveSaves();
const skipReason = !haveGameInstall() ? MISSING_GAME_MESSAGE : MISSING_SAVES_MESSAGE;

describe.skipIf(!canRunLive)(`live saves (${canRunLive ? 'live' : skipReason})`, () => {
  const BUILD_TIMEOUT = 180_000;

  it('resolves every item both characters and the transfer stash hold', { timeout: BUILD_TIMEOUT }, async () => {
    const db = await gameDb();
    const track = new CoverageTracker();

    const stash = haveTransferStash()
      ? parseTransferStash(readFileSync(snapshotSharedSave(TRANSFER_STASH_PATH)))
      : undefined;
    const formulas = haveFormulas()
      ? parseFormulasFile(readFileSync(snapshotSharedSave(FORMULAS_PATH)))
      : undefined;

    const resolved = CHARACTERS.map((name, i) => {
      const path = snapshotCharacterSave(name);
      // The account-wide files belong to the account, not to a character —
      // attribute them once or the coverage denominator counts them twice.
      return resolveCharacter(
        parseGdc(readFileSync(path), { path }),
        i === 0 ? stash : undefined,
        i === 0 ? formulas : undefined,
        db,
        track,
      );
    });

    const coverage = track.report();
    const ratio = coverage.baseResolved / coverage.baseTotal;
    // Stage 3's acceptance gate. It currently sits at 100%: item identity comes
    // from the game's own archives, so a miss would mean a parser bug, not a
    // gap in someone else's data dump.
    expect(coverage.baseTotal).toBeGreaterThan(100);
    expect(ratio, `unresolved: ${coverage.baseMissing.join(', ')}`).toBeGreaterThanOrEqual(0.95);

    // Every character has gear on, and every resolved item reads as a name.
    for (const character of resolved) {
      const equipped = character.items.filter((i) => i.source === 'equipped');
      expect(equipped.length).toBeGreaterThan(0);
      for (const item of equipped) {
        expect(item.display).not.toBe('');
        expect(item.base).toBeDefined();
      }
    }
  });

  it('names affixes, leaving only the game’s nameless crafting bonuses', { timeout: BUILD_TIMEOUT }, async () => {
    const db = await gameDb();
    const track = new CoverageTracker();
    for (const name of CHARACTERS) {
      const path = snapshotCharacterSave(name);
      resolveCharacter(parseGdc(readFileSync(path), { path }), undefined, undefined, db, track);
    }
    const coverage = track.report();
    expect(coverage.affixTotal).toBeGreaterThan(20);
    expect(coverage.affixMissing).toEqual([]);
    // Whatever is unnamed must be nameless by the game's design, not a gap: the
    // blacksmith's crafting bonuses and a relic's rolled completion bonus are
    // both shown as bare stat lines in game, with no name of their own.
    for (const record of coverage.affixUnnamed) {
      expect(record).toMatch(/^records\/items\/lootaffixes\/(crafting|completionrelics)\//);
    }
  });

  it('resolves learned blueprints to their crafted item', { timeout: BUILD_TIMEOUT }, async () => {
    if (!haveFormulas()) return;
    const db = await gameDb();
    const path = snapshotCharacterSave(CHARACTERS[0]);
    const character = resolveCharacter(
      parseGdc(readFileSync(path), { path }),
      undefined,
      parseFormulasFile(readFileSync(snapshotSharedSave(FORMULAS_PATH))),
      db,
    );
    expect(character.recipes.length).toBeGreaterThan(0);
    expect(character.recipes.every((r) => r.name)).toBe(true);
    expect(character.recipes.some((r) => r.resultName)).toBe(true);
  });
});
