import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { decompressLz4Block, readArz } from '../src/core/db/arz.js';
import { cleanText } from '../src/core/db/build.js';
import { archivesFingerprint, findGameDir, gameArchives } from '../src/core/db/gamefiles.js';
import { loadGameDb } from '../src/core/db/index.js';
import { parseItemDb, parseL10n } from '../src/core/db/grimtools.js';
import { REP_TIERS } from '../src/core/db/types.js';
import { MISSING_GAME_MESSAGE, gameDb, haveGameInstall } from './paths.js';

// ---------------------------------------------------------------------------
// LZ4 — synthetic, no game needed
// ---------------------------------------------------------------------------

describe('LZ4 block decompression', () => {
  it('decodes literals and an overlapping back-reference', () => {
    // token 0x31: 3 literals, match length 1+4=5; offset 1 → repeats the last
    // byte. Overlapping matches are how LZ4 encodes runs, so this is the case a
    // bulk copy would get wrong.
    const src = Buffer.from([0x31, 0x61, 0x62, 0x63, 0x01, 0x00]);
    expect(decompressLz4Block(src, 8).toString('latin1')).toBe('abcccccc');
  });

  it('decodes an extended literal length', () => {
    // token 0xf0: literal length 15 + extension byte 5 = 20 literals, no match.
    const literals = Buffer.from('x'.repeat(20));
    const src = Buffer.concat([Buffer.from([0xf0, 0x05]), literals]);
    expect(decompressLz4Block(src, 20).toString('latin1')).toBe('x'.repeat(20));
  });

  it('refuses to produce the wrong number of bytes', () => {
    const src = Buffer.from([0x30, 0x61, 0x62, 0x63]);
    expect(() => decompressLz4Block(src, 99)).toThrow(/produced 3 bytes/);
  });

  it('rejects a match offset that points before the output', () => {
    const src = Buffer.from([0x01, 0x05, 0x00]);
    expect(() => decompressLz4Block(src, 8)).toThrow(/bad match offset/);
  });
});

describe('cleanText', () => {
  it('strips the game’s inline colour codes from names', () => {
    expect(cleanText('^kDread Skull')).toBe('Dread Skull');
  });

  it('turns ^n into a line break and drops the rest', () => {
    expect(cleanText('"Flavour."^w^n(Applied to rings)')).toBe('"Flavour."\n(Applied to rings)');
  });

  it('leaves ordinary text alone', () => {
    expect(cleanText("Kymon's Chosen")).toBe("Kymon's Chosen");
  });
});

describe('readArz', () => {
  it('rejects a buffer that is not an archive', () => {
    const notArz = Buffer.alloc(64);
    notArz.writeUInt16LE(9, 0);
    expect(() => readArz(notArz)).toThrow(/magic 9/);
  });

  it('rejects an unsupported archive version', () => {
    const wrongVersion = Buffer.alloc(64);
    wrongVersion.writeUInt16LE(2, 0);
    wrongVersion.writeUInt16LE(99, 2);
    expect(() => readArz(wrongVersion)).toThrow(/version 99/);
  });
});

// ---------------------------------------------------------------------------
// GrimTools dump validation — synthetic, no network
// ---------------------------------------------------------------------------

describe('GrimTools dump validation', () => {
  const goodItemDb = 'window.gameVersion="Version 1.3.0.0";window.allItems={it1:{}};window.factions={f5:{}};';

  it('accepts a well-formed itemdb', () => {
    expect(parseItemDb(goodItemDb).gameVersion).toBe('Version 1.3.0.0');
  });

  it('names the missing global when a key is gone', () => {
    const altered = 'window.allItems={it1:{}};window.factions={f5:{}};';
    expect(() => parseItemDb(altered)).toThrow(/window\.gameVersion/);
  });

  it('names the empty global rather than silently accepting it', () => {
    const emptied = 'window.gameVersion="v";window.allItems={};window.factions={f5:{}};';
    expect(() => parseItemDb(emptied)).toThrow(/window\.allItems: is empty/);
  });

  it('reports a truncated download instead of failing later', () => {
    // A cut-off file assigns nothing; `window` stays empty.
    expect(() => parseItemDb('window.gameVersi')).toThrow(/window\.gameVersion/);
  });

  it('reports a syntactically broken dump as an evaluation failure', () => {
    expect(() => parseItemDb('window.allItems={it1:')).toThrow(/could not evaluate/);
  });

  it('accepts a well-formed localization table', () => {
    const tags = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`tag${i}`, `text ${i}`]));
    const src = `db_l10n_texts['en']=${JSON.stringify(tags)};`;
    expect(parseL10n(src, 'en')['tag7']).toBe('text 7');
  });

  it('names the locale that is missing from the table', () => {
    expect(() => parseL10n("db_l10n_texts['de']={};", 'en')).toThrow(/db_l10n_texts\['en'\] is missing/);
  });

  it('rejects a localization table too small to be complete', () => {
    expect(() => parseL10n("db_l10n_texts['en']={a:'b'};", 'en')).toThrow(/too few tags/);
  });
});

// ---------------------------------------------------------------------------
// The real database — needs the game installed
// ---------------------------------------------------------------------------

describe.skipIf(!haveGameInstall())(`game database (${haveGameInstall() ? 'live' : MISSING_GAME_MESSAGE})`, () => {
  // The first run parses ~26k records and may download the localization table.
  const BUILD_TIMEOUT = 180_000;

  it('reads every archive the install provides', () => {
    const gameDir = findGameDir()!;
    const archives = gameArchives(gameDir);
    expect(archives.map((a) => a.expansion)).toContain('base');
    // Same inputs, same key — this is what keeps the cache from re-downloading.
    expect(archivesFingerprint(archives)).toBe(archivesFingerprint(archives));
  });

  it('parses a known record straight out of the archive', () => {
    const archives = gameArchives(findGameDir()!);
    const base = archives.find((a) => a.expansion === 'base')!;
    const records = readArz(readFileSync(base.path), {
      filter: (r) => r === 'records/items/gearrelic/c003_relic.dbr',
    });
    const relic = records.get('records/items/gearrelic/c003_relic.dbr');
    expect(relic?.type).toBe('ItemArtifact');
    // `description` is the name tag for relics; gear uses `itemNameTag`.
    expect(relic?.fields['description']).toBe('tagRelicC003');
  });

  it('resolves item records to localized names, rarity and level', { timeout: BUILD_TIMEOUT }, async () => {
    const db = await gameDb();
    expect(db.gameVersion).toMatch(/^Version /);

    const relic = db.getItem('records/items/gearrelic/c003_relic.dbr');
    expect(relic?.name).toBe('Slaughter');
    expect(relic?.slot).toBe('ItemArtifact');
    expect(relic?.iconPath).toMatch(/\.tex$/);

    // A record only GDX1/GDX3 define — proves the expansion merge is wired up.
    const gdxLegs = db.getItem('records/items/gearlegs/c109_legs.dbr');
    expect(gdxLegs?.name).toBe('Shadoweave Leggings');
    expect(gdxLegs?.expansion).toBe('gdx3');

    // Affix names — the open question Stage 3 was meant to answer.
    expect(db.getAffixName('records/items/lootaffixes/prefix/aa004b_cunmod_01.dbr')).toBe('Shrewd');
    expect(db.getAffixName('records/items/lootaffixes/suffix/a014b_ch_speedattack_03_je.dbr')).toBeTruthy();
  });

  it('knows crafting-bonus affixes even though they have no name', { timeout: BUILD_TIMEOUT }, async () => {
    const db = await gameDb();
    const crafting = 'records/items/lootaffixes/crafting/ao306_poison.dbr';
    expect(db.knowsAffix(crafting)).toBe(true);
    expect(db.getAffixName(crafting)).toBeUndefined();
    expect(db.knowsAffix('records/items/lootaffixes/prefix/does_not_exist.dbr')).toBe(false);
  });

  it('lists faction vendor stock per reputation tier', { timeout: BUILD_TIMEOUT }, async () => {
    const db = await gameDb();
    const kymon = db.factions().find((f) => f.name === "Kymon's Chosen");
    expect(kymon?.hasVendor).toBe(true);

    const respected = db.vendorItems(kymon!.id, 'Respected');
    expect(respected.length).toBeGreaterThan(0);
    expect(respected.some((i) => i.name.startsWith('Chosen '))).toBe(true);
    // Every item knows this faction sells it, at a tier at or below the one asked for.
    for (const item of respected) {
      const source = item.vendors?.find((v) => v.factionId === kymon!.id);
      expect(source, `${item.record} should list ${kymon!.id} as a vendor`).toBeDefined();
      expect(REP_TIERS.indexOf(source!.repTier)).toBeLessThanOrEqual(REP_TIERS.indexOf('Respected'));
    }

    // Tiers accumulate: a higher tier is a superset of the ones below it.
    const revered = db.vendorItems(kymon!.id, 'Revered');
    expect(revered.length).toBeGreaterThan(respected.length);

    // Consumables and component blueprints are sold by more than one faction —
    // the model has to keep all of them, not just the first one seen.
    const shared = revered.find((i) => (i.vendors?.length ?? 0) > 1);
    expect(shared, 'expected at least one item stocked by several factions').toBeDefined();
    // Augments are the point of faction vendors — Honored is where they start.
    expect(db.vendorItems(kymon!.id, 'Honored').some((i) => i.slot === 'ItemEnchantment')).toBe(true);
  });

  it('names blueprints and what they craft', { timeout: BUILD_TIMEOUT }, async () => {
    const db = await gameDb();
    const recipe = db
      .recipes()
      .find((r) => r.record === 'records/items/crafting/blueprints/armor/craft_headd28_bloodragerscowl.dbr');
    expect(recipe?.name).toBe("Blueprint: Bloodrager's Cowl");
    expect(recipe?.resultName).toBe("Bloodrager's Cowl");
  });

  it('localizes tags, and echoes unknown ones rather than blanking them', { timeout: BUILD_TIMEOUT }, async () => {
    const db = await gameDb();
    expect(db.localize('tagRelicC003')).toBe('Slaughter');
    expect(db.localize('tagNoSuchThing')).toBe('tagNoSuchThing');
  });

  describe('caching', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    it('loads from db.json without touching the network', { timeout: BUILD_TIMEOUT }, async () => {
      await gameDb(); // ensure the cache exists

      globalThis.fetch = (() => {
        throw new Error('the cached database must not hit the network');
      }) as typeof fetch;

      const db = await loadGameDb();
      expect(db.getItem('records/items/gearrelic/c003_relic.dbr')?.name).toBe('Slaughter');
    });
  });
});
