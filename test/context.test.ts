import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { buildContextDoc, DEFAULT_MAX_TOKENS, type ContextInput } from '../src/core/context/builder.js';
import { damageIdentity, equipGroup, estimateTokens, selectCandidates } from '../src/core/context/filters.js';
import { describeSlots, formatStats } from '../src/core/context/statfmt.js';
import type { DbItem, GameDb } from '../src/core/db/types.js';
import { aggregateCharacter } from '../src/core/mechanics/aggregate.js';
import { RESIST_COLUMNS } from '../src/core/mechanics/stats.js';
import { ambiguousStats } from '../src/core/ai/verify.js';
import { itemId, resolveCharacter, type ResolvedItem } from '../src/core/resolve.js';
import { factionSlot, factionTier } from '../src/core/save/factions.js';
import { parseGdc } from '../src/core/save/gdc.js';
import { parseFormulasFile, parseReagents, parseTransferStash } from '../src/core/save/gst.js';
import { parseDifficulty, type ItemInstance } from '../src/core/save/types.js';
import {
  FORMULAS_PATH,
  MISSING_GAME_MESSAGE,
  MISSING_SAVES_MESSAGE,
  REAGENTS_PATH,
  TRANSFER_STASH_PATH,
  gameDb,
  haveFormulas,
  haveGameInstall,
  haveReagents,
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
    skillClass: () => undefined,
    difficultyPenalty: () => ({}),
    armorAbsorptionBase: () => 70,
    speedCaps: () => ({ attack: 200, cast: 200, run: 135 }),
    baseSpeeds: () => ({ attack: 1.25, cast: 1.25, run: 0.93, dualWieldFactor: 0.5 }),
    levelProgression: () => ({
      attributePointsPerLevel: 1,
      attributePerPoint: { physique: 8, cunning: 8, spirit: 8 },
      maxLevel: 100,
      maxDevotionPoints: 55,
    }),
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
    position: { kind: 'inventory', sack: 0, x: 0, y: 0 },
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
    attributePerPoint: { physique: 8, cunning: 8, spirit: 8 },
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

const canRunLive = haveSaves() && haveGameInstall() && haveTransferStash() && haveFormulas() && haveReagents();
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
  const materials = parseReagents(readFileSync(snapshotSharedSave(REAGENTS_PATH)));
  return {
    save,
    aggregate: aggregateCharacter(save, db, difficulty ?? save.difficulty),
    resolved: resolveCharacter(save, { stash, formulas, materials }, db),
    db,
  };
}

/** One numbered section of the document, heading included. */
function section(markdown: string, n: number): string {
  const start = markdown.indexOf(`\n## ${n}. `);
  const next = markdown.indexOf(`\n## ${n + 1}. `);
  return markdown.slice(start, next === -1 ? undefined : next);
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
  it('emits all twelve sections inside the default budget, untrimmed', async () => {
    const doc = buildContextDoc(await context('_Suchka'));
    // Twelve since Stage 6B: §12 is the unlock ladder, which sits after the
    // task because the task now points at it.
    for (let n = 2; n <= 12; n++) {
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
    for (let n = 2; n <= 12; n++) {
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

  it('reads the reagent store, so loose components are tagged [materials]', async () => {
    const input = await context('_Suchka');
    const doc = buildContextDoc(input);

    // Every loose component lives in reagents.gst, not in a bag — the file this
    // tool did not open until Stage 6B.
    expect(input.resolved.items.some((i) => i.source === 'materials')).toBe(true);
    expect(section(doc.markdown, 8)).toContain('[materials]');
    // A zero-quantity row is a "have held this" marker, not stock.
    expect(input.resolved.items.every((i) => i.source !== 'materials' || i.stackCount > 0)).toBe(true);
  });

  it('prints stats for every census entry, and never a Grants without them', async () => {
    const doc = buildContextDoc(await context('_Suchka'));
    const eight = section(doc.markdown, 8);

    const entries = eight.split('\n').filter((l) => l.startsWith('- **'));
    expect(entries.length).toBeGreaterThan(10);

    // A bare "Grants: <skill>" anywhere in the document is the defect Part 2b
    // fixes: the buff hop must follow and render what the skill does.
    for (const line of doc.markdown.split('\n')) {
      const grants = /Grants: ([^;\n]+)/.exec(line);
      if (!grants) continue;
      const tail = grants[1]!;
      const named = tail.includes('pet skill') || tail.includes(' — ');
      expect(named, `bare Grants in: ${line.slice(0, 140)}`).toBe(true);
    }
  });

  it('says how each granted skill is obtained, not just that it exists', async () => {
    const doc = buildContextDoc(await context('_Suchka'));
    const kinds = new Set(
      [...doc.markdown.matchAll(/Grants: [^(]+\(([^)]+)\)/g)].map((m) => m[1]!.split(' —')[0]!.split(' on')[0]!),
    );
    // A passive's numbers are simply true; a toggle's cost energy; an activated
    // skill needs a button; a proc is a chance. The reader should not have to
    // infer which from the presence of an "Energy Reserved" line.
    expect(kinds.has('passive')).toBe(true);
    expect(kinds.has('toggle')).toBe(true);
    expect(kinds.has('activated')).toBe(true);
    expect([...kinds].some((k) => k.startsWith('auto-cast'))).toBe(true);
    expect([...kinds]).not.toContain('unknown activation');
    expect(section(doc.markdown, 2)).toContain('**Granted skills.**');
  });

  it('obeys the qualified-stat rule it imposes on the answer', async () => {
    // The prompt tells the model never to write a bare "+12 Fire", and
    // `verify.ts` reports one as an error. The document has to hold itself to
    // that: the first live run under the check copied "57% pierce · 32%
    // bleeding" straight out of §4's composition line and was flagged for it.
    const doc = buildContextDoc(await context('_Suchka'));
    const bare = new Map<string, string>();
    for (const line of doc.markdown.split('\n')) {
      for (const hit of ambiguousStats(line)) if (!bare.has(hit)) bare.set(hit, line.trim().slice(0, 120));
    }
    expect([...bare].map(([hit, line]) => `${hit} — ${line}`)).toEqual([]);
  });

  it('states the per-copy component stacking rule', async () => {
    expect(section(buildContextDoc(await context('_Suchka')).markdown, 2)).toContain('per copy');
  });

  it('lists components with their craft origin, and relics only in §10', async () => {
    const input = await context('_Suchka');
    const doc = buildContextDoc(input);
    const eight = section(doc.markdown, 8);
    const ten = section(doc.markdown, 10);

    // Components are one list, whatever their origin.
    expect(eight).toMatch(/\*\*craftable now\*\* from /);
    // A reagent chain the character can close is resolved rather than reported
    // as a shortfall.
    expect(eight).toContain('after first crafting');

    // §10 keeps relics and drops gear. Slaughter is a relic and one of this
    // character's dual-wield enablers, so its line has to survive.
    expect(doc.markdown).toContain('Slaughter');
    for (const line of ten.split('\n').filter((l) => l.startsWith('- **'))) {
      const name = /^- \*\*(.+?)\*\*/.exec(line)?.[1];
      if (!name || line.includes('purchasable at')) continue;
      const recipe = input.db.recipes().find((r) => (r.resultName ?? r.name) === name);
      const result = recipe?.resultRecord ? input.db.getItem(recipe.resultRecord) : undefined;
      if (result) expect(result.slot, `${name} should not be in §10`).not.toBe('ItemRelic');
    }
  });

  it('names the evidence on both sides of the on-type note', async () => {
    const doc = buildContextDoc(await context('_Suchka'));
    const seven = section(doc.markdown, 7);

    // No bare boolean survives.
    expect(seven).not.toContain('note: matches the build focus');
    expect(seven).not.toContain('note: **off-type** for the current build focus');
    expect(seven).toMatch(/note: on-type via .+ Damage/);
    expect(seven).toMatch(/note: off-type — .+ This is not a rejection/);
  });

  it('splits permanent from gear-granted dual-wield enablers', async () => {
    const input = await context('_Suchka');
    const doc = buildContextDoc(input);

    expect(input.aggregate.wielding.permanentEnablers).toBe(2);
    expect(doc.markdown).toContain('Enabled by **2 permanent**');
    expect(doc.markdown).toContain('no gear swap can end dual wielding');
    expect(doc.markdown).not.toContain('Any swap must keep at least one of these');
  });

  it('declares iron a non-constraint for a rich character', async () => {
    const input = await context('_Suchka');
    const doc = buildContextDoc(input);
    expect(input.save.iron).toBeGreaterThan(1_000_000);
    expect(section(doc.markdown, 2)).toContain('**Iron is not a constraint for this character**');
    expect(section(doc.markdown, 2)).toContain('do not write a budget section');
    // Prices stay in the listings either way — they cost a token each and
    // matter the moment a character is poor.
    expect(section(doc.markdown, 9)).toMatch(/\d[\d,]* iron\)/);
  });

  it('inverts the enabler warning when nothing permanent backs the dual wield', async () => {
    // No live character has a gear-only dual wield, and this is the branch where
    // the constraint is real — so it is stubbed rather than left to rot.
    const input = await context('_Suchka');
    input.aggregate.wielding.enablers = input.aggregate.wielding.enablers.filter((e) => e.source !== 'skill');
    input.aggregate.wielding.permanentEnablers = 0;

    const markdown = buildContextDoc(input).markdown;
    expect(markdown).toContain('**No permanent enabler.**');
    expect(markdown).toContain('is illegal, not merely weak');
    expect(markdown).not.toContain('no gear swap can end dual wielding');
  });

  it('keeps the iron budget for a character who is actually poor', async () => {
    const input = await context('_Suchka');
    input.save = { ...input.save, iron: 5_000 };

    const two = section(buildContextDoc(input).markdown, 2);
    expect(two).toContain('**Iron is a constraint for this character**');
    expect(two).toContain('keep a running total');
    expect(two).not.toContain('do not write a budget section');
  });

  it('states the three speeds against their caps, with the weapon term spelled out', async () => {
    const input = await context('_Suchka');
    const doc = buildContextDoc(input);
    const three = section(doc.markdown, 3);
    const speed = input.aggregate.speed;

    expect(three).toContain('**Speed.**');
    // The model, not just the number: `characterBaseAttackSpeed` reads as a
    // percentage and is not one, and the headroom figure is meaningless without
    // knowing the weapon is in the baseline.
    expect(three).toContain('additive delta in attacks/second');

    const row = doc.markdown.split('\n').find((l) => l.startsWith('| Attack |'));
    expect(row, three.slice(0, 400)).toBeDefined();
    const cells = row!.split('|').map((c) => c.trim());
    expect(cells[2]).toBe(`${speed.attack.weaponBase.toFixed(2)}/s`);
    expect(cells[6]).toContain(`${speed.attack.rateWithMaintainable.toFixed(2)}/s`);

    // The dual-wield mean is the weapons' own rates, not the unarmed baseline.
    expect(speed.weapons).toHaveLength(2);
    expect(speed.attack.weaponBase).toBeCloseTo(
      speed.weapons.reduce((n, w) => n + w.aps * input.db.baseSpeeds().dualWieldFactor, 0),
      6,
    );
    // A weapon's delta is negative (slower than unarmed) and small.
    for (const w of speed.weapons) {
      expect(w.delta).toBeGreaterThan(-0.5);
      expect(w.delta).toBeLessThanOrEqual(0.5);
      expect(w.aps).toBeCloseTo(input.db.baseSpeeds().attack + w.delta, 6);
    }
  });

  it('names what the attributes scale without inventing a rate', async () => {
    const three = section(buildContextDoc(await context('_Suchka')).markdown, 3);
    expect(three).toContain('Internal Trauma **Damage**');
    expect(three).toContain('**No damage scaling at all.**');
    // The rate is engine-side. Saying so is the point: the alternative is an
    // advisor that either ignores the term or makes a coefficient up.
    expect(three).toContain('is in no game record');
    expect(three).toContain('must not be used to block a move');
  });

  it('gives every component and augment an id that no item id collides with', async () => {
    const input = await context('_Suchka');
    const doc = buildContextDoc(input);

    expect(doc.socketablesById.size).toBeGreaterThan(50);
    for (const id of doc.socketablesById.keys()) {
      expect(doc.itemsById.has(id), `socketable id ${id} collides with an item id`).toBe(false);
    }

    // Every id the index holds is an id the document actually printed, or the
    // model is being told to reference something it cannot see.
    for (const [id, item] of doc.socketablesById) {
      if (!doc.markdown.includes(item.name)) continue;
      expect(doc.markdown, `${item.name} #${id}`).toContain(`\`#${id}\``);
    }
  });

  it('groups the unlock ladder by shared threshold and costs it in points', async () => {
    const input = await context('_Suchka');
    const doc = buildContextDoc(input);
    const twelve = section(doc.markdown, 12);
    const progression = input.db.levelProgression();

    // The level group is the fact the old flat HOLD list buried: many items,
    // one threshold, two levels away.
    const levelHeading = /### At level (\d+) \((\d+) levels away\) — (\d+) items? unlocks?/.exec(twelve);
    expect(levelHeading, twelve.slice(0, 400)).not.toBeNull();
    expect(Number(levelHeading![1]) - input.aggregate.level).toBe(Number(levelHeading![2]));
    expect(Number(levelHeading![3])).toBeGreaterThan(5);

    // Attribute costs are stated in points *and* in raw attribute value, with
    // the rate read from the game's level table rather than hardcoded.
    const attr = /### (\d+) attribute points? into (Physique|Cunning|Spirit) \((\d+) \2: (\d+) → (\d+)\)/.exec(twelve);
    expect(attr, twelve.slice(0, 800)).not.toBeNull();
    const [, points, name, raw, from, to] = attr!;
    const perPoint = progression.attributePerPoint[name!.toLowerCase() as 'physique' | 'cunning' | 'spirit'];
    expect(Number(raw)).toBe(Number(points) * perPoint);
    expect(Number(to) - Number(from)).toBe(Number(raw));

    // Allocation is presented as one decision, cumulative per attribute.
    expect(twelve).toContain('**Attribute allocation is one decision.**');
    expect(twelve).toMatch(/\*\*(Physique|Cunning|Spirit)\*\*: \d+ points? unlocks \d+/);

    // An item gated on two thresholds appears under both and says so.
    expect(twelve).toMatch(/also needs (level \d+|\d+ points? into)/);
  });
});
