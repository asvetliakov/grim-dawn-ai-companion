import { describe, expect, it } from 'vitest';

import type { DbAffix, DbItem, DbSet, DbSkill, GameDb } from '../src/core/db/types.js';
import { aggregateCharacter } from '../src/core/mechanics/aggregate.js';
import {
  addDefense,
  armorAbsorption,
  ARMOR_PARTS,
  conversions,
  emptyDefense,
  maxResistContributions,
  penaltyVector,
  resistContributions,
} from '../src/core/mechanics/stats.js';
import {
  addSkillBonuses,
  atRank,
  classify,
  effectiveRanks,
  emptyBonuses,
  rankValue,
  skillLabel,
} from '../src/core/mechanics/skills.js';
import type {
  CharacterSave,
  CharacterSkill,
  EquippedItem,
  ItemInstance,
} from '../src/core/save/types.js';
import { CHARACTERS, MISSING_GAME_MESSAGE, MISSING_SAVES_MESSAGE, gameDb, haveGameInstall, haveSaves } from './paths.js';
import { parseGdc } from '../src/core/save/gdc.js';
import { readFileSync } from 'node:fs';
import { characterSavePath } from '../src/core/paths.js';

// ---------------------------------------------------------------------------
// A synthetic world, so the rules are testable without the game installed
// ---------------------------------------------------------------------------

const SCALAR = (value: unknown): number => (typeof value === 'number' ? value : 0);

function skill(record: string, over: Partial<DbSkill> = {}): DbSkill {
  return { record, class: 'Skill_Passive', stats: {}, ...over };
}

function item(record: string, over: Partial<DbItem> = {}): DbItem {
  return { record, name: record, levelReq: 1, rarity: 'Common', slot: 'x', iconPath: '', stats: {}, ...over };
}

interface World {
  items?: Record<string, DbItem>;
  affixes?: Record<string, DbAffix>;
  skills?: Record<string, DbSkill>;
  sets?: Record<string, DbSet>;
  penalty?: Record<string, Record<string, number>>;
}

function stubDb(world: World): GameDb {
  return {
    gameVersion: 'test',
    getItem: (r) => world.items?.[r],
    getAffixName: (r) => world.affixes?.[r]?.name,
    knowsAffix: (r) => r in (world.affixes ?? {}),
    getAffix: (r) => world.affixes?.[r],
    getSkill: (r) => world.skills?.[r],
    getSet: (r) => world.sets?.[r],
    skillName: (r) => world.skills?.[r]?.name,
    difficultyPenalty: (d) => world.penalty?.[d] ?? {},
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

function instance(over: Partial<ItemInstance> = {}): EquippedItem {
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
    attached: true,
    ...over,
  };
}

function characterSkill(record: string, level: number): CharacterSkill {
  return {
    record,
    level,
    enabled: true,
    devotionLevel: 0,
    devotionExperience: 0,
    sublevel: 0,
    active: false,
    autoCastSkill: '',
    autoCastController: '',
  };
}

function save(over: Partial<CharacterSave> = {}): CharacterSave {
  return {
    headerVersion: 2,
    dataVersion: 8,
    name: 'Test',
    sex: 0,
    classRecord: '',
    level: 50,
    hardcore: false,
    expansionStatus: 0,
    difficulty: 'Ultimate',
    greatestDifficultyCompleted: 'Elite',
    iron: 0,
    tributes: 0,
    attributes: {
      level: 50,
      experience: 0,
      attributePoints: 0,
      skillPoints: 0,
      devotionPoints: 0,
      totalDevotionPoints: 0,
      physique: 0,
      cunning: 0,
      spirit: 0,
      health: 0,
      energy: 0,
    },
    skills: [],
    devotions: [],
    masteriesAllowed: 2,
    skillReclamationPointsUsed: 0,
    devotionReclamationPointsUsed: 0,
    equipment: Array.from({ length: 12 }, () => null),
    weaponSet1: [null, null],
    weaponSet2: [null, null],
    alternateWeaponSetActive: false,
    inventorySacks: [],
    personalStash: [],
    factions: [],
    playStats: { playTimeSeconds: 0, deaths: 0, kills: 0 },
    blocks: [],
    warnings: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Per-rank tables
// ---------------------------------------------------------------------------

describe('rankValue', () => {
  const table = [10, 20, 29, 38];

  it('reads a leveled stat at the rank, one-based', () => {
    expect(rankValue(table, 1)).toBe(10);
    expect(rankValue(table, 3)).toBe(29);
  });

  it('clamps a rank past the end of the table to its last entry', () => {
    // `skillUltimateLevel` routinely exceeds the array on records the game never
    // lets you push that far; reading past the end must not produce undefined.
    expect(rankValue(table, 99)).toBe(38);
    expect(rankValue(table, 0)).toBe(10);
  });

  it('treats a scalar as applying at every rank, and a string as no value', () => {
    expect(rankValue(25, 7)).toBe(25);
    expect(rankValue('records/skills/x.dbr', 7)).toBe(0);
  });

  it('reads a set bonus table by equipped piece count', () => {
    // Set bonuses use the same shape, indexed by pieces rather than ranks.
    const byPieces = [0, 8, 8];
    expect(rankValue(byPieces, 1)).toBe(0);
    expect(rankValue(byPieces, 2)).toBe(8);
    expect(rankValue(byPieces, 3)).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Which band a skill's numbers belong in
// ---------------------------------------------------------------------------

describe('classify', () => {
  const PNEUMATIC = 'records/skills/playerclass04/nightbladeenchant1.dbr';
  const AWAKENING = 'records/skills/playerclass04/nightbladeenchant3.dbr';
  const VEIL = 'records/skills/playerclass04/veilofshadows1.dbr';
  const VEIL_BUFF = 'records/skills/playerclass04/veilofshadows1_buff.dbr';
  const NIGHTS_CHILL = 'records/skills/playerclass04/veilofshadows2.dbr';
  const AURA = 'records/skills/playerclass10/amatokpact1.dbr';
  const AURA_BUFF = 'records/skills/playerclass10/amatokpact1_buff.dbr';

  const db = stubDb({
    skills: {
      [PNEUMATIC]: skill(PNEUMATIC, { class: 'Skill_BuffSelfDuration', duration: 60, cooldown: 8 }),
      [AWAKENING]: skill(AWAKENING, { class: 'Skill_Modifier' }),
      [VEIL]: skill(VEIL, { class: 'Skill_BuffRadiusToggled', buffRecord: VEIL_BUFF }),
      [VEIL_BUFF]: skill(VEIL_BUFF, { class: 'SkillBuff_Debuf' }),
      [NIGHTS_CHILL]: skill(NIGHTS_CHILL, { class: 'Skill_Modifier' }),
      [AURA]: skill(AURA, { class: 'Skill_BuffRadiusToggled', buffRecord: AURA_BUFF }),
      [AURA_BUFF]: skill(AURA_BUFF, { class: 'SkillBuff_Passive' }),
    },
  });

  it('counts a self-buff you can hold up indefinitely', () => {
    // 60 seconds of buff on an 8-second cooldown is permanent in practice, and
    // the community (and grimtools, toggled on) counts it.
    expect(classify(db.getSkill(PNEUMATIC)!, db)).toEqual({ band: 'maintainable' });
  });

  it('excludes a buff whose cooldown outlasts it, and says why', () => {
    const burst = stubDb({
      skills: { x: skill('x', { class: 'Skill_BuffSelfDuration', duration: 5, cooldown: 20 }) },
    });
    expect(classify(burst.getSkill('x')!, burst)).toEqual({ band: 'excluded', reason: 'temporary' });
  });

  it('counts a toggled aura as permanent, through its buff record', () => {
    expect(classify(db.getSkill(AURA)!, db)).toEqual({ band: 'permanent' });
  });

  it('routes an enemy debuff to resistance reduction, never to defence', () => {
    // Veil of Shadows applies a debuff; its `defensive*` numbers are negative and
    // belong to the enemy. Adding them to the player would be a silent lie.
    expect(classify(db.getSkill(VEIL)!, db)).toEqual({ band: 'rr' });
  });

  it('gives a modifier its parent’s band, both ways round', () => {
    // Same class, same fields, opposite meaning: Night's Chill hangs off a
    // debuff (so: RR), Elemental Awakening off a maintainable buff.
    expect(classify(db.getSkill(NIGHTS_CHILL)!, db)).toEqual({ band: 'rr' });
    expect(classify(db.getSkill(AWAKENING)!, db)).toEqual({ band: 'maintainable' });
  });

  it('excludes circuit breakers and procs', () => {
    const world = stubDb({
      skills: {
        breaker: skill('breaker', { class: 'Skill_PassiveOnLifeBuffSelf' }),
        crit: skill('crit', { class: 'Skill_PassiveOnCritBuffSelf' }),
        potion: skill('potion', { class: 'Skill_PotionModifier' }),
      },
    });
    expect(classify(world.getSkill('breaker')!, world)).toEqual({ band: 'excluded', reason: 'circuitBreaker' });
    expect(classify(world.getSkill('crit')!, world)).toEqual({ band: 'excluded', reason: 'proc' });
    expect(classify(world.getSkill('potion')!, world)).toEqual({ band: 'excluded', reason: 'potion' });
  });

  it('names a skill through the buff record when the activator has no tag', () => {
    // Bone Chilling Cry's activator carries neither name nor max level.
    const CRY = 'records/skills/playerclass10/bonechillingcry1.dbr';
    const world = stubDb({
      skills: {
        [CRY]: skill(CRY, { class: 'Skill_AttackBuffRadius', buffRecord: `${CRY}buff` }),
        [`${CRY}buff`]: skill(`${CRY}buff`, { class: 'SkillBuff_Debuf', name: 'Bone Chilling Cry' }),
      },
    });
    expect(skillLabel(world.getSkill(CRY)!, world)).toBe('Bone Chilling Cry');
  });
});

// ---------------------------------------------------------------------------
// Effective ranks
// ---------------------------------------------------------------------------

describe('effective skill ranks', () => {
  const MASTERY = 'records/skills/playerclass04/_classtraining_class04.dbr';
  const TAKEN = 'records/skills/playerclass04/passive1.dbr';
  const UNTAKEN = 'records/skills/playerclass04/passive2.dbr';

  const db = stubDb({
    skills: {
      [MASTERY]: skill(MASTERY, { class: 'Skill_Mastery', maxLevel: 50 }),
      [TAKEN]: skill(TAKEN, { name: 'Phantasmal Armor', maxLevel: 12, ultimateLevel: 22, mastery: MASTERY }),
      [UNTAKEN]: skill(UNTAKEN, { name: 'Merciless Repertoire', maxLevel: 12, ultimateLevel: 22, mastery: MASTERY }),
    },
  });

  const gear = (stats: Record<string, string | number>) => {
    const bonuses = emptyBonuses();
    addSkillBonuses(bonuses, stats, SCALAR);
    return bonuses;
  };

  it('adds per-skill, per-mastery and all-skill bonuses together', () => {
    const bonuses = gear({
      augmentSkillName1: TAKEN,
      augmentSkillLevel1: 3,
      augmentMasteryName1: MASTERY,
      augmentMasteryLevel1: 1,
      augmentAllLevel: 2,
    });
    const ranks = effectiveRanks([characterSkill(TAKEN, 10)], bonuses, db);
    expect(ranks.get(TAKEN)).toMatchObject({ invested: 10, bonus: 6, effective: 16, capped: false });
  });

  it('gives nothing to a skill with no points in it', () => {
    // Grim Dawn has no oskills: `+N to <skill>` needs a point invested first.
    const bonuses = gear({ augmentSkillName1: UNTAKEN, augmentSkillLevel1: 5 });
    const ranks = effectiveRanks([characterSkill(UNTAKEN, 0)], bonuses, db);
    expect(ranks.has(UNTAKEN)).toBe(false);
  });

  it('clamps at the ultimate level and flags that further +skills are wasted', () => {
    const bonuses = gear({ augmentSkillName1: TAKEN, augmentSkillLevel1: 20 });
    expect(effectiveRanks([characterSkill(TAKEN, 12)], bonuses, db).get(TAKEN)).toMatchObject({
      effective: 22,
      capped: true,
    });
  });

  it('leaves the mastery bar alone — it is not a skill', () => {
    const bonuses = gear({ augmentAllLevel: 5 });
    expect(effectiveRanks([characterSkill(MASTERY, 32)], bonuses, db).get(MASTERY)).toMatchObject({
      bonus: 0,
      effective: 32,
    });
  });
});

// ---------------------------------------------------------------------------
// The stat vocabulary
// ---------------------------------------------------------------------------

describe('resistance extraction', () => {
  it('expands elemental and all-resistance fields', () => {
    expect(resistContributions({ defensiveElementalResistance: 26, defensiveChaos: 22 }, SCALAR)).toEqual({
      fire: 26,
      cold: 26,
      lightning: 26,
      chaos: 22,
    });
    expect(resistContributions({ defensiveAllResistance: 5 }, SCALAR).bleeding).toBe(5);
  });

  it('never counts a negative resistance as defence', () => {
    // A negative `defensive*` is resistance *reduction* applied to an enemy.
    expect(resistContributions({ defensiveCold: -30, defensiveFire: 10 }, SCALAR)).toEqual({ fire: 10 });
  });

  it('reads leveled resistances at the given rank', () => {
    expect(resistContributions({ defensivePoison: [10, 20, 30] }, atRank(3))).toEqual({ acid: 30 });
  });

  it('keeps maximum-resistance bonuses out of the totals', () => {
    const stats = { defensiveFireMaxResist: 3, defensiveAllMaxResist: 2 };
    expect(resistContributions(stats, SCALAR)).toEqual({});
    expect(maxResistContributions(stats, SCALAR)).toMatchObject({ fire: 5, chaos: 2 });
  });

  it('drops a conversion the record declares but leaves at zero', () => {
    expect(conversions({ conversionInType: 'Cold', conversionOutType: 'Pierce', conversionPercentage: 0 }, SCALAR)).toEqual([]);
    expect(
      conversions({ conversionInType: 'Elemental', conversionOutType: 'Pierce', conversionPercentage: 30 }, SCALAR),
    ).toEqual([{ from: 'Elemental', to: 'Pierce', percent: 30 }]);
  });

  it('applies the difficulty penalty per resistance, not as one flat number', () => {
    // The difficulty screen says "−50% to all resistances"; the game's own
    // balancing record disagrees, and it is the one that runs.
    const penalty = penaltyVector({ defensiveFire: -50, defensiveAether: -25 });
    expect(penalty).toEqual({ fire: -50, aether: -25 });
    expect(penalty.physical).toBeUndefined();
  });
});

describe('armour', () => {
  it('multiplies the base absorption rather than adding to it', () => {
    // +20% absorption is 70 × 1.2 = 84%, not 90%. Getting this additive
    // overstates mitigation on every character carrying absorption gear.
    expect(armorAbsorption(70, 20)).toBeCloseTo(84);
    expect(armorAbsorption(70, 0)).toBe(70);
    // Absorption cannot exceed 100%: everything inside the rating is stopped.
    expect(armorAbsorption(70, 100)).toBe(100);
  });

  it('weights the six hit locations to a whole', () => {
    expect(ARMOR_PARTS.reduce((n, p) => n + p.hitChance, 0)).toBe(100);
  });

  it('treats defensiveProtection as a piece rating only on an armour piece', () => {
    // On a ring or a skill the same field is a character-wide bonus that the
    // engine adds to every body part — worth far more than its face value.
    const piece = addDefense(emptyDefense(), { defensiveProtection: 991 }, SCALAR, {
      protectionIsPieceRating: true,
    });
    expect(piece.bonusArmor).toBe(0);
    const global = addDefense(emptyDefense(), { defensiveProtection: 40 }, SCALAR);
    expect(global.bonusArmor).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// The matrix over a whole (synthetic) loadout
// ---------------------------------------------------------------------------

describe('resistanceMatrix', () => {
  const LEGS = 'records/items/gearlegs/legs.dbr';
  const PREFIX = 'records/items/lootaffixes/prefix/p.dbr';
  const COMPONENT = 'records/items/materia/c.dbr';
  const AUGMENT = 'records/items/enchants/a.dbr';
  const PASSIVE = 'records/skills/playerclass04/passive1.dbr';
  const BUFF = 'records/skills/playerclass04/buff1.dbr';
  const SET = 'records/items/lootsets/set.dbr';
  const CHEST = 'records/items/geartorso/chest.dbr';

  const db = stubDb({
    items: {
      [LEGS]: item(LEGS, {
        name: 'Legguards',
        stats: { defensiveAether: 38, defensivePhysical: 4, defensiveProtection: 450 },
        setRecord: SET,
      }),
      [CHEST]: item(CHEST, {
        name: 'Jacket',
        stats: { defensiveChaos: 22, defensiveProtection: 991 },
        setRecord: SET,
      }),
      [COMPONENT]: item(COMPONENT, {
        name: 'Plate',
        stats: { defensiveBonusProtection: 35, defensiveAbsorptionModifier: 20 },
      }),
      [AUGMENT]: item(AUGMENT, { name: 'Powder', stats: { defensiveAether: 15, defensiveChaos: 15 } }),
    },
    affixes: {
      [PREFIX]: { record: PREFIX, name: 'Impervious', jitter: 10, stats: { defensivePierce: 48, defensivePoison: 60 } },
    },
    skills: {
      [PASSIVE]: skill(PASSIVE, { name: 'Phantasmal Armor', maxLevel: 12, ultimateLevel: 22, stats: { defensivePierce: [3, 5, 8, 10] } }),
      [BUFF]: skill(BUFF, {
        name: 'Pneumatic Burst',
        class: 'Skill_BuffSelfDuration',
        duration: 60,
        cooldown: 8,
        stats: { defensiveFire: 30 },
      }),
    },
    sets: {
      [SET]: { record: SET, name: 'Test Set', members: [LEGS, CHEST], bonuses: { defensiveCold: [0, 12] } },
    },
    penalty: { Ultimate: { defensiveAether: -25, defensivePierce: -50 } },
  });

  const equipment: (EquippedItem | null)[] = Array.from({ length: 12 }, () => null);
  equipment[2] = instance({ baseName: CHEST });
  equipment[3] = instance({ baseName: LEGS, prefixName: PREFIX, relicName: COMPONENT, augmentName: AUGMENT });

  const aggregate = aggregateCharacter(
    save({ equipment, skills: [characterSkill(PASSIVE, 3), characterSkill(BUFF, 1)] }),
    db,
  );
  const r = aggregate.resistances;

  it('gives every part of a slot its own attributable row', () => {
    const legs = r.rows.filter((row) => row.slot === 'Legs').map((row) => row.kind);
    // The component grants armour, not resistance, so it contributes no row —
    // but base, prefix and augment each have to be separable for a swap delta.
    expect(legs).toEqual(['base', 'prefix', 'augment']);
    expect(r.rows.find((row) => row.kind === 'prefix')?.note).toBe('prefix, ±10% roll');
  });

  it('sums items, affixes, augments, sets and passives into the permanent band', () => {
    expect(r.permanent).toMatchObject({
      physical: 4,
      pierce: 48 + 8, // prefix + Phantasmal Armor at rank 3
      acid: 60,
      aether: 38 + 15,
      chaos: 22 + 15,
      cold: 12, // two-piece set bonus
    });
  });

  it('reports maintainable buffs as a separate band rather than folding them in', () => {
    expect(r.permanent.fire ?? 0).toBe(0);
    expect(r.withMaintainable.fire).toBe(30);
    expect(aggregate.maintained).toEqual([{ name: 'Pneumatic Burst', rank: 1, duration: 60, cooldown: 8 }]);
  });

  it('applies the difficulty penalty and shows the cap it is measured against', () => {
    expect(r.effective.aether).toBe(53 - 25);
    expect(r.effective.pierce).toBe(56 - 50);
    // Physical takes no penalty in the game's balancing table.
    expect(r.effective.physical).toBe(4);
    expect(r.caps.aether).toBe(80);
  });

  it('reads the set bonus at the number of pieces actually worn', () => {
    const row = r.rows.find((row) => row.kind === 'set');
    expect(row?.note).toBe('2/2 pieces');
    expect(row?.values.cold).toBe(12);
  });

  it('keeps armour per body part instead of pooling it', () => {
    const d = aggregate.defense;
    // The engine rolls one location per hit and meets it with that piece alone,
    // so 991 + 450 is not a thing the character ever has. The component's flat
    // +35 lands on every part, including the four with no armour at all.
    expect(d.armorSlots.find((s) => s.slot === 'Chest')).toMatchObject({ piece: 991, effective: 991 + 35 });
    expect(d.armorSlots.find((s) => s.slot === 'Legs')).toMatchObject({ piece: 450, effective: 450 + 35 });
    expect(d.armorSlots.find((s) => s.slot === 'Head')).toMatchObject({ piece: 0, effective: 35 });
    // A bare slot is the finding worth surfacing, not a rounding detail.
    expect(d.weakestSlot?.piece).toBe(0);
    // Hit-weighted, not a sum: 24% chest + 20% legs + 35 flat everywhere else.
    expect(d.armorAverage).toBeCloseTo(0.24 * 1026 + 0.2 * 485 + 0.56 * 35);
  });

  it('reports the resulting absorption, not the raw modifier', () => {
    expect(aggregate.defense.absorptionPercent).toBe(20);
    expect(aggregate.defense.absorption).toBeCloseTo(84);
  });

  it('names every category it left out', () => {
    expect(aggregate.exclusions.join('\n')).toMatch(/granted by items/);
    expect(aggregate.exclusions.join('\n')).toMatch(/jitter/);
  });
});

// ---------------------------------------------------------------------------
// Against the installed game
// ---------------------------------------------------------------------------

describe.skipIf(!haveGameInstall())(`mechanics vs the game (${haveGameInstall() ? 'live' : MISSING_GAME_MESSAGE})`, () => {
  const TIMEOUT = 180_000;

  it('indexes skills with their per-rank tables', { timeout: TIMEOUT }, async () => {
    const db = await gameDb();
    const burst = db.getSkill('records/skills/playerclass04/nightbladeenchant1.dbr');
    expect(burst?.name).toBe('Pneumatic Burst');
    expect(burst?.duration).toBe(60);
    expect(burst?.cooldown).toBe(8);
    expect(burst?.ultimateLevel).toBe(22);
    expect(rankValue(burst!.stats['characterOffensiveAbility']!, 1)).toBe(10);
    expect(rankValue(burst!.stats['characterOffensiveAbility']!, 22)).toBe(200);
  });

  it('follows a toggled aura to the record that holds its numbers', { timeout: TIMEOUT }, async () => {
    const db = await gameDb();
    const veil = db.getSkill('records/skills/playerclass04/veilofshadows1.dbr');
    expect(veil?.buffRecord).toBe('records/skills/playerclass04/veilofshadows1_buff.dbr');
    // The activator itself is empty — this is why the hop is not optional.
    expect(Object.keys(veil!.stats)).toHaveLength(0);
    expect(db.getSkill(veil!.buffRecord!)?.class).toBe('SkillBuff_Debuf');
  });

  it('exposes the weapon whitelist that build-defining attacks carry', { timeout: TIMEOUT }, async () => {
    const db = await gameDb();
    // Savage Strike is two-handed only; recommending a one-hander would disable it.
    expect(db.getSkill('records/skills/playerclass06/savagestrike1.dbr')?.weapons).toEqual([
      'Axe2h',
      'Mace2h',
      'Ranged2h',
      'Sword2h',
    ]);
    // Aether Ray needs a caster off-hand, which is a different kind of trap.
    expect(db.getSkill('records/skills/playerclass05/aetherray1.dbr')?.weapons).toEqual(['Offhand']);
    // A passive is unrestricted, and says so by having no list at all.
    expect(db.getSkill('records/skills/playerclass04/passive1.dbr')?.weapons).toBeUndefined();
  });

  it('carries affix stats, not just affix names', { timeout: TIMEOUT }, async () => {
    const db = await gameDb();
    const affix = db.getAffix('records/items/lootaffixes/prefix/ad009b_res_piercepoison_05.dbr');
    expect(affix?.name).toBe('Impervious');
    expect(affix?.stats).toMatchObject({ defensivePierce: 48, defensivePoison: 60 });
    expect(affix?.jitter).toBe(10);
    // A crafting bonus is known and carries stats even though it has no name.
    const crafting = db.getAffix('records/items/lootaffixes/crafting/ao306_poison.dbr');
    expect(crafting?.name).toBeUndefined();
    expect(crafting?.stats['offensiveSlowPoisonModifier']).toBe(15);
  });

  it('indexes sets with bonuses indexed by piece count', { timeout: TIMEOUT }, async () => {
    const db = await gameDb();
    const set = db.getSet('records/items/lootsets/itemset_c019.dbr');
    expect(set?.name).toBe('Miasma');
    expect(set?.members).toHaveLength(3);
    // Nothing at one piece, +8% health from two onward.
    expect(rankValue(set!.bonuses['characterLifeModifier']!, 1)).toBe(0);
    expect(rankValue(set!.bonuses['characterLifeModifier']!, 2)).toBe(8);
  });

  it('reads the base armour absorption out of the game engine record', { timeout: TIMEOUT }, async () => {
    const db = await gameDb();
    // `records/game/gameengine.dbr`, not `records/ingameui/gameengine.dbr`,
    // which is a different record carrying a stale 66.
    expect(db.armorAbsorptionBase()).toBe(70);
  });

  it('reads the difficulty penalty out of the game’s balancing record', { timeout: TIMEOUT }, async () => {
    const db = await gameDb();
    const ultimate = db.difficultyPenalty('Ultimate');
    expect(ultimate['defensiveFire']).toBe(-50);
    // Not the flat "−50 to everything" the difficulty screen implies.
    expect(ultimate['defensiveAether']).toBe(-25);
    expect(ultimate['defensivePhysical']).toBeUndefined();
    expect(db.difficultyPenalty('Normal')).toEqual({});
  });

  it('carries what a blueprint consumes, so affordability is checkable', { timeout: TIMEOUT }, async () => {
    const db = await gameDb();
    const awakened = db
      .recipes()
      .find((r) => r.record === 'records/items/crafting/blueprints/awakened/weapons/craft_gun2h_c026.dbr');
    expect(awakened?.ironCost).toBe(200_000);
    expect(awakened?.baseReagent?.record).toBe('records/items/upgraded/gearweapons/guns2h/c026_gun2h.dbr');
    expect(awakened?.reagents[0]).toMatchObject({ name: 'Ashes of Awakening', quantity: 12 });
  });

  it('resolves a relic’s completion bonus and its granted skill', { timeout: TIMEOUT }, async () => {
    const db = await gameDb();
    expect(db.getItem('records/items/gearrelic/c003_relic.dbr')?.grantedSkill?.name).toBe('Bloodbath');
    expect(db.getAffix('records/items/lootaffixes/completionrelics/anight_19a.dbr')?.stats).toMatchObject({
      augmentSkillLevel1: 1,
    });
  });
});

describe.skipIf(!haveGameInstall() || !haveSaves())(
  `aggregates vs the live save (${haveGameInstall() && haveSaves() ? 'live' : MISSING_SAVES_MESSAGE})`,
  () => {
    const TIMEOUT = 180_000;

    it('bands, ranks and profiles a real character', { timeout: TIMEOUT }, async () => {
      const db = await gameDb();
      const path = characterSavePath(CHARACTERS[0]);
      const agg = aggregateCharacter(parseGdc(readFileSync(path), { path }), db);

      // Every equipped slot with resistances on it should be attributable.
      expect(agg.resistances.rows.some((r) => r.kind === 'base')).toBe(true);
      expect(agg.resistances.rows.some((r) => r.kind === 'augment')).toBe(true);
      expect(agg.resistances.rows.some((r) => r.kind === 'devotion')).toBe(true);

      // Pneumatic Burst is the maintainable band's reason for existing.
      expect(agg.maintained.map((m) => m.name)).toContain('Pneumatic Burst');
      const awakening = agg.resistances.rows.find((r) => r.label === 'Elemental Awakening');
      expect(awakening?.band).toBe('maintainable');
      // 11 invested + 1 from the relic's +1 to all Nightblade skills.
      expect(awakening?.note).toBe('rank 12');

      // A pierce/bleed build has to read as one.
      expect(agg.damage.ranked.slice(0, 2).map((d) => d.key)).toEqual(['pierce', 'bleeding']);

      // Night's Chill is resistance reduction, not defence — the sign trap.
      expect(agg.damage.resistReduction.some((rr) => rr.source === "Night's Chill")).toBe(true);
      expect(agg.resistances.rows.some((r) => r.label === "Night's Chill")).toBe(false);

      // Nothing may render as a raw record path.
      const labels = [
        ...agg.resistances.rows.map((r) => r.label),
        ...agg.ranks.map((r) => r.name),
        ...agg.damage.resistReduction.map((r) => r.source),
      ];
      expect(labels.filter((l) => l.includes('.dbr'))).toEqual([]);
    });

    it('scales the totals by difficulty without touching the raw sums', { timeout: TIMEOUT }, async () => {
      const db = await gameDb();
      const path = characterSavePath(CHARACTERS[0]);
      const parsed = parseGdc(readFileSync(path), { path });
      const normal = aggregateCharacter(parsed, db, 'Normal');
      const ultimate = aggregateCharacter(parsed, db, 'Ultimate');

      expect(normal.resistances.permanent).toEqual(ultimate.resistances.permanent);
      expect(normal.resistances.effective.fire).toBe(normal.resistances.withMaintainable.fire);
      expect(ultimate.resistances.effective.fire).toBe(normal.resistances.effective.fire! - 50);
      expect(ultimate.resistances.effective.physical).toBe(normal.resistances.effective.physical);
    });
  },
);
