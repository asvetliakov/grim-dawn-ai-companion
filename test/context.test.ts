import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { buildContextDoc, DEFAULT_MAX_TOKENS, type ContextInput } from '../src/core/context/builder.js';
import { damageIdentity, equipGroup, estimateTokens, selectCandidates } from '../src/core/context/filters.js';
import { describeSlots, formatStats } from '../src/core/context/statfmt.js';
import type { DbItem, GameDb } from '../src/core/db/types.js';
import { aggregateCharacter } from '../src/core/mechanics/aggregate.js';
import { RESIST_COLUMNS } from '../src/core/mechanics/stats.js';
import { itemId, resolveCharacter, type ResolvedItem } from '../src/core/resolve.js';
import { factionSlot, factionTier } from '../src/core/save/factions.js';
import { parseGdc } from '../src/core/save/gdc.js';
import { parseFormulasFile, parseTransferStash } from '../src/core/save/gst.js';
import { parseDifficulty, type ItemInstance } from '../src/core/save/types.js';
import {
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
// A stub world, so the formatting rules are testable without the game installed
// ---------------------------------------------------------------------------

function stubDb(skills: Record<string, string> = {}, items: Record<string, DbItem> = {}): GameDb {
  return {
    gameVersion: 'test',
    getItem: (record) => items[record],
    getAffixName: () => undefined,
    knowsAffix: () => false,
    getAffix: () => undefined,
    getSkill: () => undefined,
    getSet: () => undefined,
    skillName: (record) => skills[record],
    difficultyPenalty: () => ({}),
    armorAbsorptionBase: () => 70,
    speedCaps: () => ({ attack: 200, cast: 200, run: 135 }),
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

function resolved(over: Partial<ResolvedItem> = {}): ResolvedItem {
  return {
    id: 'test',
    record: 'records/items/x.dbr',
    display: 'X',
    source: 'inventory',
    location: 'bag 1 (0,0)',
    stackCount: 1,
    unresolved: [],
    ...over,
  };
}

function dbItem(over: Partial<DbItem> = {}): DbItem {
  return {
    record: 'records/items/x.dbr',
    name: 'X',
    levelReq: 1,
    rarity: 'Magical',
    slot: 'WeaponMelee_Sword',
    iconPath: '',
    stats: {},
    ...over,
  };
}

describe('formatStats', () => {
  const db = stubDb({ 'records/skills/a.dbr': 'Amarasta’s Quick Cut' });

  it('renders resistances, attributes and modifiers as the game words them', () => {
    const lines = formatStats(
      { defensiveChaos: 18, characterStrength: 24, offensiveChaosModifier: 35, defensiveFireMaxResist: 3 },
      { db },
    );
    expect(lines).toContain('+18% Chaos Resistance');
    expect(lines).toContain('+24 Physique');
    expect(lines).toContain('+35% Chaos Damage');
    expect(lines).toContain('+3% Maximum Fire Resistance');
  });

  it('pairs flat damage min/max and carries a damage-over-time duration', () => {
    const lines = formatStats(
      {
        offensivePhysicalMin: 56,
        offensivePhysicalMax: 109,
        offensiveSlowBleedingMin: 8,
        offensiveSlowBleedingDurationMin: 3,
      },
      { db },
    );
    expect(lines).toContain('+56–109 Physical Damage');
    expect(lines).toContain('+8 Bleeding Damage over 3 Seconds');
  });

  it('names damage conversion in the profile’s own vocabulary, not the DBR dialect', () => {
    const lines = formatStats(
      { conversionInType: 'Elemental', conversionOutType: 'Poison', conversionPercentage: 30 },
      { db },
    );
    expect(lines).toContain('30% Elemental Damage converted to Acid Damage');
  });

  it('renders skill references as names', () => {
    const lines = formatStats({ augmentSkillName1: 'records/skills/a.dbr', augmentSkillLevel1: 2 }, { db });
    expect(lines).toContain('+2 to Amarasta’s Quick Cut');
  });

  it('reads a per-rank table at the rank it is given', () => {
    const read = (v: unknown): number => (Array.isArray(v) ? (v[3] as number) : (v as number));
    const lines = formatStats({ characterOffensiveAbility: [10, 20, 30, 40] }, { db, read });
    expect(lines).toContain('+40 Offensive Ability');
  });

  it('never silently drops an unknown stat', () => {
    const lines = formatStats({ someBrandNewStat: 7 }, { db });
    expect(lines).toContain('`someBrandNewStat: 7`');
  });

  it('drops engine plumbing that is not a stat', () => {
    const lines = formatStats({ physicsMass: 1, ragDollDirection: 'Push', itemLevel: 58 }, { db });
    expect(lines).toEqual([]);
  });

  it('reads a negative player-facing resistance as enemy resistance reduction', () => {
    expect(formatStats({ defensiveCold: -28 }, { db })).toContain('-28% Enemy Cold Resistance');
  });
});

describe('describeSlots', () => {
  it('collapses whole families to one word', () => {
    expect(describeSlots(['head', 'shoulders', 'chest', 'hands', 'legs', 'feet', 'waist'])).toBe('any armor');
    expect(describeSlots(['amulet', 'ring'])).toBe('amulet, ring');
  });

  it('says so when the data records no restriction', () => {
    expect(describeSlots(undefined)).toBe('no slot restriction recorded');
  });
});

describe('damageIdentity', () => {
  it('applies the weapon’s own armor piercing to its physical damage only', () => {
    const item = resolved({
      base: dbItem({
        stats: {
          offensivePhysicalMin: 100,
          offensivePhysicalMax: 200,
          offensiveColdMin: 10,
          offensivePierceRatioMin: 100,
        },
      }),
    });
    const identity = damageIdentity(item);
    expect(identity.pierceRatio).toBe(100);
    const pierce = identity.types.find((t) => t.key === 'pierce');
    expect(pierce).toMatchObject({ min: 100, max: 200 });
    expect(identity.types.find((t) => t.key === 'physical')).toBeUndefined();
    // Cold is untouched: armor piercing moves physical and nothing else.
    expect(identity.types.find((t) => t.key === 'cold')).toMatchObject({ min: 10, max: 10 });
  });

  it('keeps min and max apart rather than collapsing onto the midpoint', () => {
    const item = resolved({ base: dbItem({ stats: { offensiveFireMin: 20, offensiveFireMax: 60 } }) });
    expect(damageIdentity(item).types[0]).toMatchObject({ key: 'fire', min: 20, max: 60 });
  });

  it('applies the item’s own conversion, so a converting weapon reads as what it deals', () => {
    const item = resolved({
      base: dbItem({
        stats: {
          offensivePhysicalMin: 100,
          offensivePhysicalMax: 100,
          conversionInType: 'Physical',
          conversionOutType: 'Chaos',
          conversionPercentage: 100,
        },
      }),
    });
    const identity = damageIdentity(item);
    expect(identity.types).toHaveLength(1);
    expect(identity.types[0]).toMatchObject({ key: 'chaos', min: 100, max: 100 });
  });
});

describe('equipGroup', () => {
  it('maps template classes to the slot they compete for', () => {
    expect(equipGroup(dbItem({ slot: 'ArmorProtective_Waist' }))).toBe('Belt');
    expect(equipGroup(dbItem({ slot: 'ArmorJewelry_Ring' }))).toBe('Ring');
    expect(equipGroup(dbItem({ slot: 'WeaponHunting_Ranged2h' }))).toBe('Main hand');
    expect(equipGroup(dbItem({ slot: 'WeaponArmor_Offhand' }))).toBe('Off hand');
  });

  it('is undefined for anything that is not gear', () => {
    expect(equipGroup(dbItem({ slot: 'ItemRelic' }))).toBeUndefined();
    expect(equipGroup(dbItem({ slot: 'ItemEnchantment' }))).toBeUndefined();
    expect(equipGroup(undefined)).toBeUndefined();
  });
});

describe('selectCandidates', () => {
  const standing = {
    level: 50,
    attributes: { physique: 500, cunning: 500, spirit: 500 },
    reductions: { rows: [], levelFlat: 0 },
  };
  const ctx = {
    level: 50,
    standing,
    shortfalls: new Set<'fire'>(['fire']),
    topDamage: new Set<'pierce'>(['pierce']),
    unspentPoints: 0,
    perGroup: 8,
  };

  const candidate = (name: string, over: Partial<DbItem>, requirementsLevel = 50): ResolvedItem =>
    resolved({
      id: name,
      display: name,
      base: dbItem({ record: `records/items/${name}.dbr`, name, slot: 'ArmorProtective_Head', ...over }),
      requirements: { level: requirementsLevel },
    });

  it('keeps a window around the character level and drops the rest', () => {
    const result = selectCandidates(
      [candidate('near', {}, 55), candidate('far', {}, 90), candidate('ancient', {}, 10)],
      ctx,
    );
    expect(result.byGroup.get('Head')?.map((c) => c.item.display)).toEqual(['near']);
    expect(result.outOfWindow).toBe(2);
  });

  it('keeps a Common only when it covers a current resistance shortfall', () => {
    const result = selectCandidates(
      [
        candidate('plain', { rarity: 'Common' }),
        candidate('patches', { rarity: 'Common', stats: { defensiveFire: 20 } }),
      ],
      ctx,
    );
    expect(result.byGroup.get('Head')?.map((c) => c.item.display)).toEqual(['patches']);
  });

  it('ranks a shortfall-coverer above an on-type item, and caps the tail', () => {
    const items = [
      candidate('ontype', { rarity: 'Legendary', stats: { offensivePierceModifier: 50 } }),
      candidate('covers', { rarity: 'Magical', stats: { defensiveFire: 20 } }),
    ];
    const result = selectCandidates(items, { ...ctx, perGroup: 1 });
    expect(result.byGroup.get('Head')?.[0]?.item.display).toBe('covers');
    expect(result.dropped.get('Head')).toBe(1);
  });
});

describe('faction slots', () => {
  it('puts the fixed factions first and factionUser<N> at N + 6', () => {
    expect(factionSlot(1)).toEqual({ id: 'survivors', name: "Devil's Crossing" });
    expect(factionSlot(8)).toEqual({ id: 'f2', name: 'Homestead' });
    expect(factionSlot(23)).toEqual({ id: 'f17', name: 'Kurn' });
    expect(factionSlot(28)).toEqual({ id: 'f22', name: 'Asterkarn Dead' });
    expect(factionSlot(46)).toBeUndefined();
  });

  it('places the market tier thresholds exactly', () => {
    expect(factionTier(1500)).toBe('Neutral');
    expect(factionTier(1501)).toBe('Friendly');
    expect(factionTier(5000)).toBe('Friendly');
    expect(factionTier(5001)).toBe('Respected');
    expect(factionTier(10000)).toBe('Respected');
    expect(factionTier(10001)).toBe('Honored');
    expect(factionTier(24999)).toBe('Honored');
    expect(factionTier(25000)).toBe('Revered');
    expect(factionTier(-1)).toBe('Hostile');
  });
});

describe('parseDifficulty', () => {
  it('accepts names in any case and save-file indices', () => {
    expect(parseDifficulty('elite')).toBe('Elite');
    expect(parseDifficulty('ULTIMATE')).toBe('Ultimate');
    expect(parseDifficulty('0')).toBe('Normal');
    expect(parseDifficulty('2')).toBe('Ultimate');
    expect(parseDifficulty('nightmare')).toBeUndefined();
    expect(parseDifficulty('3')).toBeUndefined();
  });
});

describe('itemId', () => {
  it('is stable for the same instance and differs when the roll differs', () => {
    const a = instance({ baseName: 'records/items/a.dbr', seed: 12345 });
    expect(itemId(a)).toBe(itemId(instance({ baseName: 'records/items/a.dbr', seed: 12345 })));
    expect(itemId(a)).not.toBe(itemId(instance({ baseName: 'records/items/a.dbr', seed: 12346 })));
    expect(itemId(a)).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// The real document, against the live saves
// ---------------------------------------------------------------------------

const canRunLive = haveSaves() && haveGameInstall() && haveTransferStash() && haveFormulas();
const skipReason = !haveSaves()
  ? MISSING_SAVES_MESSAGE
  : !haveGameInstall()
    ? MISSING_GAME_MESSAGE
    : 'transfer.gst / formulas.gst not found';

/**
 * The plan's original ceiling. It is no longer the default — the document is
 * bounded by the candidate level window rather than by a budget — but the
 * builder must still be able to hit it on demand, because a tighter budget is
 * exactly what a smaller-context provider would ask for.
 */
const PLAN_TOKEN_BUDGET = 30_000;

async function context(character: string, difficulty?: 'Normal' | 'Elite' | 'Ultimate'): Promise<ContextInput> {
  const db = await gameDb();
  const save = parseGdc(readFileSync(snapshotCharacterSave(character)));
  const stash = parseTransferStash(readFileSync(snapshotSharedSave(TRANSFER_STASH_PATH)));
  const formulas = parseFormulasFile(readFileSync(snapshotSharedSave(FORMULAS_PATH)));
  return {
    save,
    aggregate: aggregateCharacter(save, db, difficulty ?? save.difficulty),
    resolved: resolveCharacter(save, stash, formulas, db),
    db,
  };
}

/** Pull one row out of a markdown table by its leading cell. */
function tableRow(markdown: string, label: string): number[] | undefined {
  const line = markdown.split('\n').find((l) => l.startsWith(`| ${label} |`));
  if (!line) return undefined;
  return line
    .split('|')
    .slice(2, -1)
    .map((cell) => (cell.trim() === '·' ? 0 : Number(cell.trim())));
}

describe.skipIf(!canRunLive)(`context document (${canRunLive ? 'live' : skipReason})`, () => {
  it('emits all eleven sections inside the default budget, untrimmed', async () => {
    const doc = buildContextDoc(await context('_Suchka'));
    for (let n = 2; n <= 11; n++) {
      expect(doc.markdown, `section ${n}`).toContain(`\n## ${n}. `);
    }
    expect(doc.markdown.startsWith('# Suchka — level ')).toBe(true);
    expect(doc.tokenEstimate).toBe(estimateTokens(doc.markdown));
    expect(doc.tokenEstimate).toBeLessThanOrEqual(DEFAULT_MAX_TOKENS);
    // The window, not the budget, is what bounds an ordinary character's
    // document — so nothing should be given up at the default settings.
    expect(doc.trimmed).toEqual([]);
  });

  it('still fits the plan’s 30k ceiling when asked to', async () => {
    const doc = buildContextDoc(await context('_Suchka'), { maxTokens: PLAN_TOKEN_BUDGET });
    expect(doc.tokenEstimate).toBeLessThanOrEqual(PLAN_TOKEN_BUDGET);
    for (let n = 2; n <= 11; n++) {
      expect(doc.markdown, `section ${n}`).toContain(`\n## ${n}. `);
    }
  });

  it('renders the resistance matrix with exactly the aggregate’s numbers', async () => {
    const input = await context('_Suchka');
    const doc = buildContextDoc(input);
    const r = input.aggregate.resistances;

    const expected = (values: Record<string, number | undefined>): number[] =>
      RESIST_COLUMNS.map((c) => Math.round(values[c.key] ?? 0));

    expect(tableRow(doc.markdown, '**permanent total**')).toEqual(expected(r.permanent));
    expect(tableRow(doc.markdown, '**+ maintainable buffs**')).toEqual(expected(r.withMaintainable));
    expect(tableRow(doc.markdown, `**${r.difficulty} penalty**`)).toEqual(expected(r.penalty));
    expect(tableRow(doc.markdown, '**effective**')).toEqual(expected(r.effective));
    expect(tableRow(doc.markdown, '**cap**')).toEqual(expected(r.caps));

    // Every per-source row is present too, so the totals are attributable.
    for (const row of r.rows) {
      expect(doc.markdown).toContain(`| ${row.slot}: ${row.label}`);
    }
  });

  it('follows the difficulty override through the header and the cap math', async () => {
    const ultimate = buildContextDoc(await context('_Suchka', 'Ultimate'));
    const elite = buildContextDoc(await context('_Suchka', 'Elite'));

    expect(elite.markdown).toContain('difficulty: **Elite**');
    expect(tableRow(elite.markdown, '**Elite penalty**')).toBeDefined();
    expect(tableRow(ultimate.markdown, '**Ultimate penalty**')).toBeDefined();

    const eliteEffective = tableRow(elite.markdown, '**effective**')!;
    const ultimateEffective = tableRow(ultimate.markdown, '**effective**')!;
    // The penalty is per-resistance, so the difference is too — but Ultimate is
    // never kinder than Elite on any column, and is strictly harsher somewhere.
    expect(eliteEffective.every((v, i) => v >= ultimateEffective[i]!)).toBe(true);
    expect(eliteEffective.some((v, i) => v > ultimateEffective[i]!)).toBe(true);
    expect(elite.markdown).toContain('Elite penalty');
  });

  it('gives every equipped item a requirement line and real stat lines', async () => {
    const input = await context('_Suchka');
    const doc = buildContextDoc(input);
    const section = doc.markdown.slice(doc.markdown.indexOf('\n## 5. '), doc.markdown.indexOf('\n## 6. '));

    const blocks = section.split(/\n### /).slice(1);
    expect(blocks.length).toBeGreaterThan(10);
    for (const block of blocks) {
      if (block.includes('**EMPTY**')) continue;
      expect(block, block.split('\n')[0]).toMatch(/- requirements: level \d+/);
      const baseLine = block.split('\n').find((l) => l.startsWith('- base: '));
      expect(baseLine, block.split('\n')[0]).toBeDefined();
      // "no equipped item renders only raw `key: value` fallbacks"
      const rendered = baseLine!.slice('- base: '.length).split('; ');
      expect(rendered.some((line) => !line.startsWith('`')), baseLine).toBe(true);
    }
  });

  it('calls out empty component sockets and missing augments', async () => {
    const doc = buildContextDoc(await context('_Suchka'));
    expect(doc.markdown).toContain('**component socket: EMPTY**');
    expect(doc.markdown).toContain('**augment: NONE**');
  });

  it('annotates candidate requirements against the character', async () => {
    const doc = buildContextDoc(await context('_Suchka'));
    const section = doc.markdown.slice(doc.markdown.indexOf('\n## 7. '), doc.markdown.indexOf('\n## 8. '));
    expect(section).toMatch(/- requirements: [^\n]*\*\*meets\*\*/);
    // At least one candidate is gated on something the character has not reached.
    expect(section).toMatch(/\*\*(needs level \d+|short \d+ (physique|cunning|spirit))\*\*/);
  });

  it('marks a component whose only copy is installed, with its host id', async () => {
    const input = await context('_Suchka');
    const doc = buildContextDoc(input);
    const section = doc.markdown.slice(doc.markdown.indexOf('\n## 8. '), doc.markdown.indexOf('\n## 9. '));

    const scarce = section.match(/single instance — extraction destroys `#(\w+)`/g) ?? [];
    expect(scarce.length).toBeGreaterThan(0);
    for (const line of scarce) {
      const id = /`#(\w+)`/.exec(line)![1]!;
      expect(doc.itemIds.has(id), `${id} should be a real item id`).toBe(true);
    }
    // Every census entry states its use-on restriction.
    for (const line of section.split('\n').filter((l) => l.startsWith('- **'))) {
      expect(line).toContain('use-on: ');
    }
  });

  it('lists only faction tiers the save actually reached', async () => {
    const input = await context('_Suchka');
    const doc = buildContextDoc(input);
    const section = doc.markdown.slice(doc.markdown.indexOf('\n## 9. '), doc.markdown.indexOf('\n## 10. '));

    const order = ['Friendly', 'Respected', 'Honored', 'Revered'];
    const reps = new Map(
      input.save.factions
        .filter((f) => f.unlocked)
        .flatMap((f) => {
          const slot = factionSlot(f.id);
          return slot ? [[slot.name, factionTier(f.value)] as const] : [];
        }),
    );

    const headings = [...section.matchAll(/^### (.+) — (\w+) \(/gm)];
    expect(headings.length).toBeGreaterThan(0);
    for (const [, name, tier] of headings) {
      expect(reps.get(name!), `${name} should be an unlocked faction`).toBe(tier);
      expect(order).toContain(tier!);
    }

    // Every augment names the tier it unlocks at, and never one above the
    // character's, and states a use-on restriction.
    for (const line of section.split('\n').filter((l) => l.startsWith('- **'))) {
      expect(line).toContain('use-on: ');
      expect(line).toMatch(/\(lvl \d+, (Friendly|Respected|Honored|Revered), [\d,?]+ iron\)/);
    }
  });

  it('trims progressively and reports what it gave up', async () => {
    const input = await context('_Suchka');
    const roomy = buildContextDoc(input, { maxTokens: 200_000 });
    const tight = buildContextDoc(input, { maxTokens: 12_000 });

    expect(roomy.trimmed).toEqual([]);
    expect(tight.trimmed.length).toBeGreaterThan(0);
    expect(tight.markdown.length).toBeLessThan(roomy.markdown.length);
    // The matrix and the equipped blocks survive every trim.
    expect(tight.markdown).toContain('**permanent total**');
    expect(tight.markdown).toContain('\n## 5. Equipped');
  });

  it('gives every rendered item a unique id', async () => {
    const doc = buildContextDoc(await context('_Suchka'));
    const ids = [...doc.markdown.matchAll(/`#(\w+)`/g)].map((m) => m[1]!);
    const perName = new Map<string, string>();
    for (const line of doc.markdown.split('\n')) {
      const heading = /^#{3,4} .+ — (.+) `#(\w+)`$/.exec(line);
      if (!heading) continue;
      const previous = perName.get(heading[2]!);
      expect(previous === undefined || previous === heading[1], `id ${heading[2]} reused`).toBe(true);
      perName.set(heading[2]!, heading[1]!);
    }
    expect(ids.length).toBeGreaterThan(10);
  });

  it('works for a low-level character with almost nothing on', async () => {
    const doc = buildContextDoc(await context('_abcdef'));
    expect(doc.markdown).toContain('\n## 11. Task');
    expect(doc.tokenEstimate).toBeLessThanOrEqual(PLAN_TOKEN_BUDGET);
  });
});
