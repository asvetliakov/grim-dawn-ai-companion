import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { decompressLz4Block, readArz } from '../src/core/db/arz.js';
import { cleanText } from '../src/core/db/build.js';
import { archivesFingerprint, findGameDir, gameArchives, readGameVersion } from '../src/core/db/gamefiles.js';
import { availableLocales, parseTagFile, readGameText } from '../src/core/db/gametext.js';
import { loadGameDb } from '../src/core/db/index.js';
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

  it('drops the grammatical gender marker gendered languages open a name with', () => {
    expect(cleanText('[ms]стеклянный глаз снайпера')).toBe('стеклянный глаз снайпера');
    expect(cleanText('[np]набедренники кровавого обряда')).toBe('набедренники кровавого обряда');
  });

  it('keeps one form of an adjective that spells out every declension', () => {
    // Without this the name reads as all four forms run together.
    expect(cleanText('[ms]искусный[fs]искусная[ns]искусное[np]искусные')).toBe('искусный');
  });

  it('leaves ordinary text alone', () => {
    expect(cleanText("Kymon's Chosen")).toBe("Kymon's Chosen");
    // Only a leading marker is markup; brackets in the body are the name.
    expect(cleanText('Ugdenbog [Reinforced]')).toBe('Ugdenbog [Reinforced]');
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
// Localization files — synthetic, no game needed
// ---------------------------------------------------------------------------

describe('tags_*.txt parsing', () => {
  it('reads key=value pairs, ignoring comments and blank lines', () => {
    const tags = parseTagFile('# Items\r\n\r\ntagRelicC003=Slaughter\r\ntagEmpty=\r\n');
    expect(tags['tagRelicC003']).toBe('Slaughter');
    // A tag with no text is still a tag: it is how the game blanks one out.
    expect(tags['tagEmpty']).toBe('');
    expect(Object.keys(tags)).toHaveLength(2);
  });

  it('splits on the first = so values may contain their own', () => {
    expect(parseTagFile('tagFormula=2 + 2 = 4')['tagFormula']).toBe('2 + 2 = 4');
  });

  it('strips the byte-order mark the base archive opens with', () => {
    // Left in place, the BOM rides along inside the first key and that one tag
    // silently stops resolving.
    expect(parseTagFile('﻿tagTitleScreenText=Grim Dawn')['tagTitleScreenText']).toBe('Grim Dawn');
  });

  it('keeps the game’s formatting escapes for cleanText to deal with', () => {
    expect(parseTagFile('tagX=^kDread Skull')['tagX']).toBe('^kDread Skull');
  });

  it('merges files in order, later definitions winning', () => {
    const tags = parseTagFile('tagA=base\ntagB=base');
    parseTagFile('tagA=expansion', tags);
    expect(tags).toEqual({ tagA: 'expansion', tagB: 'base' });
  });

  it('ignores lines that are not assignments', () => {
    expect(parseTagFile('not a tag line\n=novalue\n')).toEqual({});
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

  it('reads the localization table out of the game’s own text archives', () => {
    const gameDir = findGameDir()!;
    const tags = readGameText(gameDir, 'en', gameArchives(gameDir));
    expect(tags['tagRelicC003']).toBe('Slaughter');
    // The download this replaced carried 16,246 tags; the game ships more, and
    // a regression here would most likely be "only the base archive was read".
    expect(Object.keys(tags).length).toBeGreaterThan(19_000);
    // Expansion text merges on top of the base game's.
    expect(tags['tagGDX3Class10SkillDescription01A']).toMatch(/werewolf/i);
  });

  it('offers every locale the install ships, and names them when one is absent', () => {
    const gameDir = findGameDir()!;
    const locales = availableLocales(gameDir);
    expect(locales).toContain('EN');
    // Locale codes are matched case-insensitively — settings say `en`, the file
    // is `Text_EN.arc`.
    expect(readGameText(gameDir, 'EN', gameArchives(gameDir))['tagRelicC003']).toBe('Slaughter');
    expect(() => readGameText(gameDir, 'xx', gameArchives(gameDir))).toThrow(
      new RegExp(`no Text_XX\\.arc.*this install ships: ${locales[0]}`, 's'),
    );
  });

  it('reads the installed game version out of Engine.dll', () => {
    // The marker has to be unambiguous, not merely present — `readGameVersion`
    // returns undefined rather than guessing if a patch ever makes it plural.
    expect(readGameVersion(findGameDir()!)).toMatch(/^\d+\.\d+\.\d+(\.\d+)?$/);
    expect(readGameVersion('/definitely/not/a/game/dir')).toBeUndefined();
  });

  it('resolves item records to localized names, rarity and level', { timeout: BUILD_TIMEOUT }, async () => {
    const db = await gameDb();
    expect(db.gameVersion).toMatch(/^\d+\.\d+\.\d+/);

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

    // Attribute requirements come from the cost equations, so coverage is a
    // property of the build, not of luck with the loot tables.
    expect(db.stats().itemsWithAttrReq).toBeGreaterThan(5_000);

    // Player speed caps, from the engine record — +% speed past these is wasted.
    expect(db.speedCaps()).toEqual({ attack: 200, cast: 200, run: 135 });
  });

  it('types the use-on restriction on components and augments', { timeout: BUILD_TIMEOUT }, async () => {
    const db = await gameDb();

    // Attuned Lodestone fits amulets and medals, nothing else.
    const lodestone = db.getItem('records/items/materia/compb_lodestone.dbr');
    expect(lodestone?.slot).toBe('ItemRelic');
    expect(lodestone?.allowedSlots).toEqual(['amulet', 'medal']);

    // Seal of Might is weapons-and-shield; proposing it for armor is illegal.
    const seal = db.getItem('records/items/materia/compa_sealmight.dbr');
    expect(seal?.allowedSlots).toContain('sword');
    expect(seal?.allowedSlots).toContain('shield');
    expect(seal?.allowedSlots).not.toContain('chest');

    // A faction augment: jewelry only.
    const augment = db.getItem('records/items/enchants/b17a_enchant.dbr');
    expect(augment?.slot).toBe('ItemEnchantment');
    expect(augment?.allowedSlots).toEqual(['amulet', 'ring']);

    // The flags left `stats` — kept there they read as junk stat lines and
    // would inflate nothing but the advisor context.
    for (const item of [lodestone, seal, augment]) {
      expect(Object.keys(item!.stats)).not.toContain('amulet');
      expect(Object.keys(item!.stats)).not.toContain('sword');
    }
    // 107 components + the augments; gear never carries the field.
    expect(db.stats().socketables).toBeGreaterThan(450);
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
    const realDataDir = process.env['GD_DATA_DIR'];
    let dataDir: string;

    beforeAll(() => {
      dataDir = mkdtempSync(join(tmpdir(), 'gd-db-'));
    });
    afterEach(() => {
      globalThis.fetch = realFetch;
      // The shared cache is shared: the other test files build into it too, so
      // a test that wipes and rebuilds has to do it somewhere of its own.
      if (realDataDir === undefined) delete process.env['GD_DATA_DIR'];
      else process.env['GD_DATA_DIR'] = realDataDir;
    });
    afterAll(() => {
      rmSync(dataDir, { recursive: true, force: true });
    });

    it('builds and loads without touching the network at all', { timeout: BUILD_TIMEOUT }, async () => {
      process.env['GD_DATA_DIR'] = dataDir;
      // Not just the cached path: the database is derived entirely from the
      // install now, so a *cold* build — into an empty data directory, with no
      // cache of any kind — must be offline too.
      globalThis.fetch = (() => {
        throw new Error('the database must not hit the network');
      }) as typeof fetch;

      const built = await loadGameDb();
      expect(built.getItem('records/items/gearrelic/c003_relic.dbr')?.name).toBe('Slaughter');
      expect(existsSync(join(dataDir, 'cache', built.stats().fingerprint, 'db-en.json'))).toBe(true);

      const cached = await loadGameDb();
      expect(cached.getItem('records/items/gearrelic/c003_relic.dbr')?.name).toBe('Slaughter');
    });

    it('rebuilds rather than reading a database cached for another language', { timeout: BUILD_TIMEOUT }, async () => {
      process.env['GD_DATA_DIR'] = dataDir;
      const de = await loadGameDb({ locale: 'de' });
      // Same records, different names, side by side in one build's cache — the
      // icons underneath them are language-independent and stay shared.
      expect(de.getItem('records/items/gearrelic/c003_relic.dbr')?.name).toBe('Gemetzel');
      expect(de.stats().locale).toBe('de');
      const en = await loadGameDb();
      expect(en.getItem('records/items/gearrelic/c003_relic.dbr')?.name).toBe('Slaughter');
    });
  });
});
