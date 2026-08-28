import { describe, expect, it } from 'vitest';

import type { DbAffix, DbItem, DbSet, DbSkill, GameDb } from '@grimdawn/core/db/types';
import { aggregateCharacter } from '../src/core/mechanics/aggregate.js';
import {
  addDamage,
  addDefense,
  applyConversions,
  armorAbsorption,
  ARMOR_PARTS,
  conversions,
  emptyDamage,
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
} from '@grimdawn/core/save/types';
import {
  CHARACTERS,
  MISSING_GAME_MESSAGE,
  MISSING_SAVES_MESSAGE,
  gameDb,
  haveGameInstall,
  haveSaves,
  characterSavePath,
  primaryCharacter,
} from './paths.js';
import { parseGdc } from '@grimdawn/core/save/gdc';
import { readFileSync } from 'node:fs';

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
    skillClass: () => undefined,
    masteryNumber: () => undefined,
    difficultyPenalty: (d) => world.penalty?.[d] ?? {},
    armorAbsorptionBase: () => 70,
    speedCaps: () => ({ attack: 200, cast: 200, run: 135 }),
    combatFormulas: () => ({
      attributeDamage: { physical: 1 / 245, pierce: 1 / 245, physicalDot: 1 / 215, magical: 1 / 215, magicalDot: 1 / 200 },
      hitChances: { Head: 15, Shoulders: 15, Chest: 26, Hands: 12, Legs: 20, Feet: 12 },
    }),
    baseSpeeds: () => ({ attack: 1.25, cast: 1.25, run: 0.93, dualWieldFactor: 0.5 }),
    levelProgression: () => ({
      attributePointsPerLevel: 1,
      attributePerPoint: { physique: 8, cunning: 8, spirit: 8 },
      maxLevel: 100,
      maxDevotionPoints: 55,
    }),
    factions: () => [],
    factionBoosters: () => [],
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
    unknown1: 0,
    devotionLevel: 0,
    devotionExperience: 0,
    sublevel: 0,
    active: false,
    unknown2: 0,
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
    skillEntries: [],
    skills: [],
    devotions: [],
    skillsTail: [0, 0],
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
    factionSelection: 0,
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
    ).toEqual([
      { from: 'Elemental', to: 'Pierce', percent: 30, fromKeys: ['fire', 'cold', 'lightning'], toKeys: ['pierce'] },
    ]);
  });

  it('applies the difficulty penalty per resistance, not as one flat number', () => {
    // The difficulty screen says "−50% to all resistances"; the game's own
    // balancing record disagrees, and it is the one that runs.
    const penalty = penaltyVector({ defensiveFire: -50, defensiveAether: -25 });
    expect(penalty).toEqual({ fire: -50, aether: -25 });
    expect(penalty.physical).toBeUndefined();
  });
});

describe('damage conversion typing and arithmetic', () => {
  it('speaks the player’s language, not the DBR dialect', () => {
    const [row] = conversions(
      { conversionInType: 'Life', conversionOutType: 'Poison', conversionPercentage: 25 },
      SCALAR,
    );
    expect(row).toEqual({ from: 'Vitality', to: 'Acid', percent: 25, fromKeys: ['vitality'], toKeys: ['acid'] });
  });

  it('expands a full-convert transmuter’s semicolon list and drops Stun', () => {
    const [row] = conversions(
      {
        conversionInType: 'Physical;Pierce;Elemental;Cold;Fire;Poison;Lightning;Life;Chaos;Aether;Stun',
        conversionOutType: 'Aether',
        conversionPercentage: 100,
      },
      SCALAR,
    );
    expect(row?.from).toBe('All');
    expect(row?.fromKeys).toHaveLength(9);
    expect(row?.fromKeys).not.toContain('bleeding');
    expect(row?.toKeys).toEqual(['aether']);
  });

  it('converts off the raw pool exactly once — no chaining', () => {
    // Physical → Fire and Fire → Cold together must not turn physical into
    // cold: the fire that arrives from physical is already-converted damage.
    const flat = applyConversions({ physical: 100, fire: 60 }, [
      { from: 'Physical', to: 'Fire', percent: 50, fromKeys: ['physical'], toKeys: ['fire'] },
      { from: 'Fire', to: 'Cold', percent: 100, fromKeys: ['fire'], toKeys: ['cold'] },
    ]);
    expect(flat).toEqual({ physical: 50, fire: 50, cold: 60 });
  });

  it('splits proportionally when an in-type is drawn past 100%', () => {
    const flat = applyConversions({ physical: 100 }, [
      { from: 'Physical', to: 'Fire', percent: 100, fromKeys: ['physical'], toKeys: ['fire'] },
      { from: 'Physical', to: 'Acid', percent: 100, fromKeys: ['physical'], toKeys: ['acid'] },
    ]);
    expect(flat).toEqual({ fire: 50, acid: 50 });
  });

  it('takes the DoT twin along, and leaves it behind when the target has none', () => {
    const pools = { fire: 100, burn: 40 };
    const toCold = applyConversions(pools, [
      { from: 'Fire', to: 'Cold', percent: 50, fromKeys: ['fire'], toKeys: ['cold'] },
    ]);
    expect(toCold).toEqual({ fire: 50, burn: 20, cold: 50, frostburn: 20 });
    // Pierce has no DoT counterpart: the burn stays burn, unconverted.
    const toPierce = applyConversions(pools, [
      { from: 'Fire', to: 'Pierce', percent: 50, fromKeys: ['fire'], toKeys: ['pierce'] },
    ]);
    expect(toPierce).toEqual({ fire: 50, burn: 40, pierce: 50 });
  });

  it('spreads an Elemental in-type over all three elements and an out-type as a third each', () => {
    const drained = applyConversions({ fire: 30, cold: 30, lightning: 30 }, [
      { from: 'Elemental', to: 'Pierce', percent: 100, fromKeys: ['fire', 'cold', 'lightning'], toKeys: ['pierce'] },
    ]);
    expect(drained).toEqual({ pierce: 90 });
    const emitted = applyConversions({ physical: 90 }, [
      {
        from: 'Physical',
        to: 'Elemental',
        percent: 100,
        fromKeys: ['physical'],
        toKeys: ['fire', 'cold', 'lightning'],
      },
    ]);
    expect(emitted).toEqual({ fire: 30, cold: 30, lightning: 30 });
  });

  it('never converts bleeding — no record in the game does', () => {
    const flat = applyConversions({ bleeding: 80, physical: 20 }, [
      { from: 'Physical', to: 'Chaos', percent: 100, fromKeys: ['physical'], toKeys: ['chaos'] },
    ]);
    expect(flat.bleeding).toBe(80);
  });

  it('reads flat damage as the min–max midpoint, min alone standing for itself', () => {
    const damage = addDamage(
      emptyDamage(),
      { offensivePhysicalMin: 100, offensivePhysicalMax: 200, offensiveColdMin: 30 },
      SCALAR,
    );
    expect(damage.flat).toEqual({ physical: 150, cold: 30 });
    // Flat Elemental splits a third each, midpoint first.
    const elemental = addDamage(emptyDamage(), { offensiveElementalMin: 30, offensiveElementalMax: 60 }, SCALAR);
    expect(elemental.flat).toEqual({ fire: 15, cold: 15, lightning: 15 });
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

describe('attributes and requirement checks', () => {
  const CHEST = 'records/items/geartorso/chest.dbr';
  const RING = 'records/items/gearaccessories/rings/ring.dbr';
  const MEDAL = 'records/items/gearaccessories/medals/medal.dbr';
  const PREFIX = 'records/items/lootaffixes/prefix/p.dbr';
  const SUFFIX = 'records/items/lootaffixes/suffix/s.dbr';
  const MASTERY = 'records/skills/playerclass01/_classtraining_class01.dbr';
  const PASSIVE2 = 'records/skills/playerclass01/passive2.dbr';

  const db = stubDb({
    items: {
      [CHEST]: item(CHEST, {
        name: 'Warplate',
        slot: 'ArmorProtective_Chest',
        levelReq: 40,
        attrReq: { physique: 600 },
        stats: { characterStrength: 40, characterStrengthModifier: 10 },
      }),
      [RING]: item(RING, {
        name: 'Loop',
        slot: 'ArmorJewelry_Ring',
        levelReq: 30,
        attrReq: { spirit: 300 },
        attrReqPerStat: { spirit: 2 },
        stats: { characterIntelligence: 25, itemLevel: 30, attributeScalePercent: 40 },
      }),
      // The fifteen medals carrying a zeroed reduction field are why zeros are
      // skipped; this one also grants a scoped reduction that must not reach
      // the ring's Spirit check.
      [MEDAL]: item(MEDAL, {
        name: 'Badge',
        slot: 'ArmorJewelry_Medal',
        stats: { characterMeleeStrengthReqReduction: 15, characterWeaponStrengthReqReduction: 0 },
      }),
    },
    affixes: {
      [PREFIX]: { record: PREFIX, name: 'Stalwart', levelReq: 55, stats: { characterOffensiveAbility: 20 } },
      [SUFFIX]: { record: SUFFIX, name: 'of the Squire', stats: { characterGlobalReqReduction: 10 } },
    },
    skills: {
      [MASTERY]: skill(MASTERY, {
        name: 'Soldier',
        class: 'Skill_Mastery',
        // Cumulative by rank, exactly as `_classtraining_class01.dbr` stores it.
        stats: { characterStrength: [5, 10, 15, 20], characterDexterity: [3, 7, 10, 14] },
      }),
      [PASSIVE2]: skill(PASSIVE2, {
        name: 'Fighting Spirit',
        stats: { characterArmorStrengthReqReduction: [3, 5, 8] },
      }),
    },
  });

  const equipment: (EquippedItem | null)[] = Array.from({ length: 12 }, () => null);
  equipment[2] = instance({ baseName: CHEST, prefixName: PREFIX, suffixName: SUFFIX });
  equipment[7] = instance({ baseName: RING });
  equipment[10] = instance({ baseName: MEDAL });

  const base = save({
    equipment,
    // Above the prefix's level-55 gate, so the checks exercise attributes.
    level: 60,
    skills: [characterSkill(MASTERY, 3), characterSkill(PASSIVE2, 2)],
  });
  base.attributes.physique = 500;
  base.attributes.cunning = 100;
  base.attributes.spirit = 320;
  base.attributes.attributePoints = 4;
  const aggregate = aggregateCharacter(base, db);

  it('totals attributes from the save base, mastery bar, gear and % modifiers', () => {
    // (500 base + 15 mastery at rank 3 + 40 chest) × 1.10 from the chest's +10%.
    expect(aggregate.attributes.physique).toEqual({
      base: 500,
      flat: 55,
      percent: 10,
      total: (500 + 55) * 1.1,
    });
    expect(aggregate.attributes.cunning.flat).toBe(10); // mastery only
    expect(aggregate.attributes.spirit.flat).toBe(25); // ring only
    expect(aggregate.attributes.offensiveAbility.flat).toBe(20); // prefix
    expect(aggregate.attributes.unspentPoints).toBe(4);
  });

  it('collects reductions with their scopes and skips zero-valued fields', () => {
    const rows = aggregate.requirementReductions.rows;
    expect(rows).toContainEqual({ scope: 'Melee', attr: 'physique', percent: 15, source: 'Badge' });
    expect(rows).toContainEqual({ scope: 'Global', percent: 10, source: 'of the Squire' });
    // Fighting Spirit's per-rank array, read at rank 2.
    expect(rows).toContainEqual({ scope: 'Armor', attr: 'physique', percent: 5, source: 'Fighting Spirit' });
    // The medal's zeroed template field must not become a row.
    expect(rows.some((r) => r.percent === 0)).toBe(false);
  });

  it('routes reductions by slot scope when checking an item', () => {
    const chest = aggregate.equippedRequirements.find((e) => e.slot === 'Chest');
    // Armor 5% + Global 10% apply to a chest; the Melee 15% does not.
    expect(chest?.check.effective.physique).toBe(Math.floor(600 * 0.85));
    expect(chest?.check.meets).toBe(true);

    const ring = aggregate.equippedRequirements.find((e) => e.slot === 'Ring 2');
    // Only Global reaches jewelry, and the ring's own Spirit need scales by its
    // one counted stat key — itemLevel and attributeScalePercent must not count.
    expect(ring?.check.effective.spirit).toBe(Math.floor(300 * 0.9));
    expect(ring?.check.meets).toBe(true);
  });

  it('reports deficits with the numbers a reader needs', () => {
    const poor = save({ equipment });
    poor.attributes.physique = 300;
    poor.level = 30;
    const check = aggregateCharacter(poor, db).equippedRequirements.find((e) => e.slot === 'Chest')?.check;
    expect(check?.meets).toBe(false);
    // Level 55 comes from the prefix, not the base item's 40.
    expect(check?.gaps).toContainEqual({ attr: 'level', have: 30, need: 55, deficit: 25 });
    // "Have" is the character as dressed — the chest's own +40 and +10% count.
    expect(check?.gaps).toContainEqual({ attr: 'physique', have: 374, need: 540, deficit: 166 });
  });
});

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
    // Hit-weighted, not a sum: 26% chest + 20% legs + 35 flat everywhere else —
    // the weights are the combat formulas record's own (Chest is 26, not the
    // community table's 24).
    expect(d.armorAverage).toBeCloseTo(0.26 * 1026 + 0.2 * 485 + 0.54 * 35);
  });

  it('reports the resulting absorption, not the raw modifier', () => {
    expect(aggregate.defense.absorptionPercent).toBe(20);
    expect(aggregate.defense.absorption).toBeCloseTo(84);
  });

  it('names every category it left out', () => {
    // Item-granted *conditional* skills are the exclusion; an always-on one is
    // counted on its own row, and the sentence has to say which is which.
    expect(aggregate.exclusions.join('\n')).toMatch(/item-granted procs, activated skills and pet skills/);
    expect(aggregate.exclusions.join('\n')).toMatch(/jitter/);
  });
});

describe('weapon payload index', () => {
  const SWORD = 'records/items/gearweapons/sword.dbr';
  const RING = 'records/items/gearaccessories/ring.dbr';
  const db = stubDb({
    items: {
      [SWORD]: item(SWORD, {
        name: 'Sword',
        stats: { offensivePhysicalMin: 100, offensivePhysicalMax: 200, offensivePierceMin: 50 },
      }),
      [RING]: item(RING, { name: 'Ring', stats: { offensivePhysicalModifier: 50, offensiveTotalDamageModifier: 10 } }),
    },
  });

  it('scales each flat pool by its own +% column plus the total-damage term', () => {
    const equipment: (EquippedItem | null)[] = Array.from({ length: 12 }, () => null);
    equipment[6] = instance({ baseName: RING });
    const aggregate = aggregateCharacter(
      save({ equipment, weaponSet1: [instance({ baseName: SWORD }), null] }),
      db,
    );
    // physical: midpoint 150 × (1 + (50 + 10)/100) = 240; pierce: 50 × 1.10 = 55.
    // Attack speed, crit and % Weapon Damage are deliberately absent from the
    // arithmetic — the index compares loadouts, it does not claim DPS.
    expect(aggregate.damage.payloadIndex).toBe(295);
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

  it('derives attribute requirements from the cost equations', { timeout: TIMEOUT }, async () => {
    const db = await gameDb();
    // Level-75 legendary heavy chest: the heavy_legend file's chest equation.
    expect(db.getItem('records/items/geartorso/d008_torso.dbr')?.attrReq).toEqual({ physique: 829.8 });
    // Two-handed gun at 70 — a Cunning slot.
    expect(db.getItem('records/items/gearweapons/guns2h/b008c_gun2h.dbr')?.attrReq).toEqual({ cunning: 479.5 });
    // Jewelry carries the totalAttCount kicker as a per-stat step.
    const amulet = db.getItem('records/items/gearaccessories/necklaces/c044_necklace.dbr');
    expect(amulet?.attrReq).toEqual({ spirit: 312.1 });
    expect(amulet?.attrReqPerStat).toEqual({ spirit: 2 });
    // Medals genuinely require nothing — their equation family is never populated.
    expect(db.getItem('records/items/gearaccessories/medals/d002_medal.dbr')?.attrReq).toBeUndefined();
    // The one explicit override in the whole game.
    expect(db.getItem('records/items/questitems/quest_areah_woodcarving_02.dbr')?.attrReq).toEqual({
      physique: 800,
    });
  });

  it('keeps the affixes’ own level gates', { timeout: TIMEOUT }, async () => {
    const db = await gameDb();
    // "of the Squire"-family suffix: a reduction affix with its own level gate.
    const squire = db.getAffix('records/items/lootaffixes/suffix/b_ar001_to_c.dbr');
    expect(squire?.levelReq).toBe(49);
    expect(squire?.stats['characterGlobalReqReduction']).toBe(11);
  });
});

describe('wielding modes, dual-wield enablement and set duplicates', () => {
  const SWORD = 'records/items/left.dbr';
  const SWORD2 = 'records/items/right.dbr';
  const SHIELD = 'records/items/wall.dbr';
  const RING = 'records/items/loop.dbr';
  const RING_MATE = 'records/items/loop2.dbr';
  const SET = 'records/items/twinloops.dbr';
  const DW_PASSIVE = 'records/skills/dualblades.dbr';
  const DW_WPS = 'records/skills/whirl.dbr';
  const DW_TRANSMUTER = 'records/skills/breath1b.dbr';
  const DW_MEDAL = 'records/items/direwolf.dbr';
  const DW_MEDAL_SKILL = 'records/skills/direwolfclaw.dbr';

  const db = stubDb({
    items: {
      [SWORD]: item(SWORD, { name: 'Left Fang', slot: 'WeaponMelee_Sword' }),
      [SWORD2]: item(SWORD2, { name: 'Right Fang', slot: 'WeaponMelee_Sword' }),
      [SHIELD]: item(SHIELD, { name: 'Wall', slot: 'WeaponArmor_Shield' }),
      [RING]: item(RING, { name: 'Loop', slot: 'ArmorJewelry_Ring', setRecord: SET }),
      [RING_MATE]: item(RING_MATE, { name: 'Other Loop', slot: 'ArmorJewelry_Ring', setRecord: SET }),
      [DW_MEDAL]: item(DW_MEDAL, {
        name: 'Direwolf Crest',
        slot: 'ArmorJewelry_Medal',
        grantedSkill: { record: DW_MEDAL_SKILL, name: 'Direwolf Claw' },
      }),
    },
    skills: {
      // The melee enabler shape: a flagged passive (Dual Blades). Its stats are
      // dual-wield-conditional, which is what the banding test leans on.
      [DW_PASSIVE]: skill(DW_PASSIVE, { name: 'Dual Blades', stats: { dualWieldOnly: 1, defensivePierce: [3, 5] } }),
      // A flagged mastery WPS *requires* dual wielding but does not enable it.
      [DW_WPS]: skill(DW_WPS, { name: 'Whirling Blades', class: 'Skill_WPAttack_BasicAttack', stats: { dualWieldOnly: 1 } }),
      // So does a flagged transmuter (Breath of Belgothian's shape).
      [DW_TRANSMUTER]: skill(DW_TRANSMUTER, { name: 'Breath', class: 'Skill_Transmuter', stats: { dualWieldOnly: 1 } }),
      // The same WPS shape granted by an item DOES enable ("Allows you to dual wield").
      [DW_MEDAL_SKILL]: skill(DW_MEDAL_SKILL, {
        name: 'Direwolf Claw',
        class: 'Skill_WPAttack_BasicAttack',
        stats: { dualWieldOnly: 1 },
      }),
    },
    sets: { [SET]: { record: SET, name: 'Twin Loops', members: [RING, RING_MATE], bonuses: { defensiveCold: [0, 20] } } },
  });

  const dual: (EquippedItem | null)[] = [instance({ baseName: SWORD }), instance({ baseName: SWORD2 })];

  it('counts a duplicate set item once, and distinct members normally', () => {
    const doubled: (EquippedItem | null)[] = Array.from({ length: 12 }, () => null);
    doubled[6] = instance({ baseName: RING });
    doubled[7] = instance({ baseName: RING });
    const one = aggregateCharacter(save({ equipment: doubled }), db);
    // Two copies of the same ring are one set member — the in-game counter
    // says 1, so the two-piece bonus must not fire. At one piece this set
    // grants nothing, so it earns no matrix row at all.
    expect(one.resistances.rows.find((r) => r.kind === 'set')).toBeUndefined();
    expect(one.resistances.permanent.cold ?? 0).toBe(0);

    const paired: (EquippedItem | null)[] = Array.from({ length: 12 }, () => null);
    paired[6] = instance({ baseName: RING });
    paired[7] = instance({ baseName: RING_MATE });
    const two = aggregateCharacter(save({ equipment: paired }), db);
    expect(two.resistances.rows.find((r) => r.kind === 'set')?.note).toBe('2/2 pieces');
    expect(two.resistances.permanent.cold).toBe(20);
  });

  it('reads the wielding mode off the held weapons', () => {
    const modeOf = (weaponSet1: (EquippedItem | null)[]): string =>
      aggregateCharacter(save({ weaponSet1 }), db).wielding.mode;
    expect(modeOf(dual)).toBe('dual-wield melee');
    expect(modeOf([instance({ baseName: SWORD }), instance({ baseName: SHIELD })])).toBe('weapon + shield');
    expect(modeOf([instance({ baseName: SWORD }), null])).toBe('single weapon');
    expect(modeOf([null, null])).toBe('unarmed');
  });

  it('names the invested passive as the dual-wield enabler, never the mastery WPS or a transmuter', () => {
    const agg = aggregateCharacter(
      save({
        weaponSet1: dual,
        skills: [characterSkill(DW_PASSIVE, 4), characterSkill(DW_WPS, 2), characterSkill(DW_TRANSMUTER, 1)],
      }),
      db,
    );
    expect(agg.wielding.enablers).toEqual([{ name: 'Dual Blades', source: 'skill' }]);
    // And the flagged passive's stats count while dual wielding (rank 4 clamps
    // to the table's end).
    expect(agg.resistances.permanent.pierce).toBe(5);
  });

  it('counts an item-granted flagged skill as an enabler', () => {
    const equipment: (EquippedItem | null)[] = Array.from({ length: 12 }, () => null);
    equipment[10] = instance({ baseName: DW_MEDAL });
    const agg = aggregateCharacter(save({ weaponSet1: dual, equipment }), db);
    expect(agg.wielding.enablers).toEqual([{ name: 'Direwolf Claw', source: 'granted by Direwolf Crest' }]);
  });

  it('reports dual wielding with no enabler as exactly that', () => {
    const agg = aggregateCharacter(save({ weaponSet1: dual }), db);
    expect(agg.wielding.mode).toBe('dual-wield melee');
    expect(agg.wielding.enablers).toEqual([]);
  });

  it('inerts a dual-wield-only skill when the loadout does not dual wield', () => {
    const agg = aggregateCharacter(
      save({
        weaponSet1: [instance({ baseName: SWORD }), instance({ baseName: SHIELD })],
        skills: [characterSkill(DW_PASSIVE, 4)],
      }),
      db,
    );
    expect(agg.resistances.permanent.pierce ?? 0).toBe(0);
    expect(agg.exclusions.some((line) => line.includes('dual-wield-only'))).toBe(true);
  });
});

describe('damage-type path: piercing, conversion scope and per-skill typing', () => {
  const SABRE = 'records/items/sabre.dbr';
  const PLAIN_SWORD = 'records/items/plainsword.dbr';
  const SPIKE = 'records/items/materia/spike.dbr';
  const EPAULETS = 'records/items/epaulets.dbr';
  const AURA = 'records/skills/class/brand1.dbr';
  const STRIKE = 'records/skills/class/strike1.dbr';
  const STRIKE_TRANSMUTER = 'records/skills/class/strike1b.dbr';
  const REPLACER = 'records/skills/class/onslaught1.dbr';

  const db = stubDb({
    items: {
      // 100% Armor Piercing: the whole 100–200 physical base is dealt as pierce.
      [SABRE]: item(SABRE, {
        name: 'Test Sabre',
        slot: 'WeaponMelee_Sword',
        stats: { offensivePhysicalMin: 100, offensivePhysicalMax: 200, offensivePierceRatioMin: 100 },
      }),
      [PLAIN_SWORD]: item(PLAIN_SWORD, {
        name: 'Plain Sword',
        slot: 'WeaponMelee_Sword',
        stats: { offensivePhysicalMin: 40, offensivePierceRatioMin: 50 },
      }),
      // No component in the game carries a pierce ratio; one that claimed to
      // must be ignored — the ratio is the weapon record's own, full stop.
      [SPIKE]: item(SPIKE, { name: 'Test Spike', slot: 'ItemRelic', stats: { offensivePierceRatioMin: 80 } }),
      // Global gear conversion, the Chosen Epaulets shape.
      [EPAULETS]: item(EPAULETS, {
        name: 'Test Epaulets',
        slot: 'ArmorProtective_Shoulders',
        stats: { conversionInType: 'Cold', conversionOutType: 'Pierce', conversionPercentage: 50, offensiveColdMin: 40 },
      }),
    },
    skills: {
      // A permanent buff whose conversion is global — it converts the character.
      [AURA]: skill(AURA, {
        name: 'Test Brand',
        class: 'Skill_BuffSelfToggled',
        stats: { conversionInType: 'Physical', conversionOutType: 'Life', conversionPercentage: [20, 40] },
      }),
      // An attack whose conversion is its own business, plus its transmuter.
      [STRIKE]: skill(STRIKE, {
        name: 'Test Strike',
        class: 'Skill_AttackRadius',
        stats: { weaponDamagePct: [100, 120], offensiveSlowBleedingMin: [50, 80] },
      }),
      [STRIKE_TRANSMUTER]: skill(STRIKE_TRANSMUTER, {
        name: 'Test Strike Transmuter',
        class: 'Skill_Transmuter',
        stats: { conversionInType: 'Physical', conversionOutType: 'Aether', conversionPercentage: 100 },
      }),
      [REPLACER]: skill(REPLACER, {
        name: 'Test Onslaught',
        class: 'Skill_WeaponPool_BasicAttack',
        stats: { weaponDamagePct: [110, 115], offensiveColdMin: [10, 20] },
      }),
    },
  });

  it('deals a piercing weapon’s physical as pierce, off the base record’s ratio alone', () => {
    const full = aggregateCharacter(save({ weaponSet1: [instance({ baseName: SABRE }), null] }), db);
    const entry = (agg: typeof full, key: string) => agg.damage.ranked.find((d) => d.key === key);
    expect(entry(full, 'physical')).toBeUndefined();
    expect(entry(full, 'pierce')?.flat).toBe(150); // midpoint of 100–200, all of it moved

    // The component's claimed ratio is ignored: 50% (the sword's own) applies.
    const socketed = aggregateCharacter(
      save({ weaponSet1: [instance({ baseName: PLAIN_SWORD, relicName: SPIKE }), null] }),
      db,
    );
    expect(entry(socketed, 'physical')?.flat).toBe(20);
    expect(entry(socketed, 'pierce')?.flat).toBe(20);
  });

  it('folds a permanent buff’s conversion globally, at the skill’s rank', () => {
    const agg = aggregateCharacter(
      save({
        weaponSet1: [instance({ baseName: PLAIN_SWORD }), null], // 40 phys, half → pierce
        skills: [characterSkill(AURA, 2)], // 40% Physical → Vitality
      }),
      db,
    );
    expect(agg.damage.conversions).toEqual([
      {
        from: 'Physical',
        to: 'Vitality',
        percent: 40,
        fromKeys: ['physical'],
        toKeys: ['vitality'],
        source: 'Test Brand',
        scope: 'global',
      },
    ]);
    const flatOf = (key: string) => agg.damage.ranked.find((d) => d.key === key)?.flat ?? 0;
    expect(flatOf('pierce')).toBe(20);
    expect(flatOf('physical')).toBe(12); // 20 after piercing, minus 40%
    expect(flatOf('vitality')).toBe(8);
  });

  it('keeps an attack skill’s conversion on the skill, merged from its transmuter node', () => {
    const agg = aggregateCharacter(
      save({ skills: [characterSkill(STRIKE, 2), characterSkill(STRIKE_TRANSMUTER, 1)] }),
      db,
    );
    // Nothing global: the transmuter rewrites Test Strike, not the character.
    expect(agg.damage.conversions).toEqual([]);
    expect(agg.damage.skillDamage).toEqual([
      {
        skill: 'Test Strike',
        record: STRIKE,
        rank: 2,
        weaponDamagePct: 120,
        flat: [{ key: 'bleeding', label: 'Bleeding', amount: 80, overTime: true }],
        ownPercent: [],
        conversions: [
          { from: 'Physical', to: 'Aether', percent: 100, fromKeys: ['physical'], toKeys: ['aether'] },
        ],
        isDefaultAttack: false,
      },
    ]);
  });

  it('names the default-attack replacer and the weapon attack’s composition', () => {
    const agg = aggregateCharacter(
      save({
        weaponSet1: [instance({ baseName: SABRE }), null],
        equipment: (() => {
          const eq: (EquippedItem | null)[] = Array.from({ length: 12 }, () => null);
          eq[2] = instance({ baseName: EPAULETS });
          return eq;
        })(),
        skills: [characterSkill(REPLACER, 1)],
      }),
      db,
    );
    expect(agg.damage.weaponAttack.mainAttack).toBe('Test Onslaught');
    // Pools: 150 pierce (pierced sabre) + 40 cold, half of it converted:
    // pierce 170, cold 20 → shares of 190.
    expect(agg.damage.weaponAttack.composition).toEqual([
      { key: 'pierce', label: 'Pierce', share: 89, overTime: false },
      { key: 'cold', label: 'Cold', share: 11, overTime: false },
    ]);
    // The replacer is an attack skill: its own cold stays on its row, out of the pools.
    expect(agg.damage.skillDamage[0]?.skill).toBe('Test Onslaught');
    expect(agg.damage.skillDamage[0]?.isDefaultAttack).toBe(true);
  });
});

describe('resistance reduction collection', () => {
  const AURA = 'records/skills/playerclass10/frostaura1.dbr';
  const AURA_BUFF = 'records/skills/playerclass10/frostaura1_buff.dbr';
  // `frostaura2` resolves to `frostaura1` by the stem-numbering convention, so
  // this is the Night's Chill shape: a modifier of a *permanent* toggled aura,
  // whose negative resistance reaches the aggregate through the fold.
  const CHILL = 'records/skills/playerclass10/frostaura2.dbr';
  const CURSE = 'records/skills/playerclass10/curse1.dbr';
  const RR_STRIKE = 'records/skills/playerclass10/rrstrike1.dbr';

  const db = stubDb({
    skills: {
      [AURA]: skill(AURA, { name: 'Test Aura', class: 'Skill_BuffRadiusToggled', buffRecord: AURA_BUFF }),
      [AURA_BUFF]: skill(AURA_BUFF, { class: 'SkillBuff_Passive' }),
      [CHILL]: skill(CHILL, {
        name: 'Test Chill',
        class: 'Skill_Modifier',
        stats: { defensiveCold: [-20, -24, -28] },
      }),
      [CURSE]: skill(CURSE, {
        name: 'Test Curse',
        class: 'SkillBuff_Debuf',
        stats: {
          defensiveAllResistance: [-10, -12, -15],
          offensiveElementalResistanceReductionPercentMin: [18, 20, 22],
          offensiveElementalResistanceReductionPercentDurationMin: [3, 3, 3],
        },
      }),
      [RR_STRIKE]: skill(RR_STRIKE, {
        name: 'Test Rend',
        class: 'Skill_AttackRadius',
        stats: {
          weaponDamagePct: [100, 110, 120],
          offensiveTotalResistanceReductionAbsoluteMin: [10, 14, 18],
          offensiveSlowFireModifier: [40, 60, 80],
          offensivePhysicalMin: [5, 10, 15],
        },
      }),
    },
  });

  it('reads an rr skill’s negative resistances as categorized RR rows, once, and keeps them out of the matrix', () => {
    const agg = aggregateCharacter(save({ skills: [characterSkill(CURSE, 2)] }), db);
    expect(agg.damage.resistReduction).toEqual([
      {
        source: 'Test Curse',
        effect: '-12% to All Enemy Resistances',
        value: 12,
        category: 'percent',
        scope: 'all',
        rank: 2,
        record: CURSE,
      },
      {
        source: 'Test Curse',
        effect: '-20% Enemy Fire, Cold and Lightning Resistances',
        value: 20,
        category: 'percentReduced',
        scope: 'elemental',
        durationSeconds: 3,
        rank: 2,
        record: CURSE,
      },
    ]);
    // The debuff's numbers belong to the enemy — nothing lands in the matrix.
    expect(agg.resistances.rows).toEqual([]);
  });

  it('captures on-hit RR and own +% from an attack skill without touching the global pools', () => {
    const agg = aggregateCharacter(save({ skills: [characterSkill(RR_STRIKE, 3)] }), db);
    expect(agg.damage.resistReduction).toEqual([
      {
        source: 'Test Rend',
        effect: '-18 to All Enemy Resistances',
        value: 18,
        category: 'flat',
        scope: 'all',
        rank: 3,
        record: RR_STRIKE,
      },
    ]);
    const row = agg.damage.skillDamage[0]!;
    expect(row.record).toBe(RR_STRIKE);
    expect(row.flat).toEqual([{ key: 'physical', label: 'Physical', amount: 15, overTime: false }]);
    expect(row.ownPercent).toEqual([{ key: 'burn', label: 'Burn', percent: 80, overTime: true }]);
    // The skill's own flat and +% scale that skill alone: the character's
    // ranked profile stays empty with no gear and no global sources.
    expect(agg.damage.ranked).toEqual([]);
  });

  it('collects a permanent aura modifier’s negative resistance as RR through the fold', () => {
    const agg = aggregateCharacter(
      save({ skills: [characterSkill(AURA, 1), characterSkill(CHILL, 3)] }),
      db,
    );
    expect(agg.damage.resistReduction).toEqual([
      {
        source: 'Test Chill',
        effect: '-28% Enemy Cold Resistance',
        value: 28,
        category: 'percent',
        scope: 'Cold',
        rank: 3,
        record: CHILL,
      },
    ]);
    // …and never as a hole in the player's own matrix.
    expect(agg.resistances.rows).toEqual([]);
  });
});

describe('skills granted by gear', () => {
  const RELIC = 'records/items/gearrelic/relic.dbr';
  const HELM = 'records/items/helm.dbr';
  const SWORD = 'records/items/sword.dbr';
  const AURA_ACT = 'records/skills/itemskills/relics/aura.dbr';
  const AURA_BUFF = 'records/skills/itemskills/relics/aura_buff.dbr';
  const PROC = 'records/skills/itemskills/nova.dbr';

  const db = stubDb({
    items: {
      // The Deathchill shape: the relic's own small line, and an aura carrying
      // four times as much — the aura is the reason to wear it.
      [RELIC]: item(RELIC, {
        name: 'Test Relic',
        slot: 'ItemArtifact',
        stats: { offensiveColdModifier: 36, itemSkillName: AURA_ACT },
      }),
      // A second item granting the *same* aura. Both apply.
      [SWORD]: item(SWORD, { name: 'Test Sword', slot: 'WeaponMelee_Sword', stats: { itemSkillName: AURA_ACT } }),
      [HELM]: item(HELM, { name: 'Test Helm', slot: 'ArmorProtective_Head', stats: { itemSkillName: PROC } }),
    },
    skills: {
      // The two-record shape: a nameless toggled activator pointing at the buff
      // that carries the name and every stat.
      [AURA_ACT]: skill(AURA_ACT, { class: 'Skill_BuffRadiusToggled', buffRecord: AURA_BUFF }),
      [AURA_BUFF]: skill(AURA_BUFF, {
        name: 'Test Aura',
        class: 'SkillBuff_Passive',
        stats: { offensiveColdModifier: 125, defensiveCold: 20, characterManaLimitReserve: 150 },
      }),
      [PROC]: skill(PROC, { name: 'Test Nova', class: 'Skill_AttackRadius', stats: { offensiveColdMin: 280 } }),
    },
  });

  const worn = (): (EquippedItem | null)[] => {
    const eq: (EquippedItem | null)[] = Array.from({ length: 12 }, () => null);
    eq[0] = instance({ baseName: HELM });
    eq[11] = instance({ baseName: RELIC });
    return eq;
  };
  const agg = aggregateCharacter(save({ equipment: worn() }), db);
  const twice = aggregateCharacter(
    save({ equipment: worn(), weaponSet1: [instance({ baseName: SWORD }), null] }),
    db,
  );

  it('sums an always-on grant, naming it through the activator→buff hop', () => {
    // 36 (the relic's own line) + 125 (the aura it grants) — the whole point:
    // reading the relic's line alone makes swapping it away look like a gain.
    expect(agg.damage.ranked.find((d) => d.key === 'cold')?.percent).toBe(161);
    expect(agg.resistances.permanent.cold).toBe(20);
    const row = agg.resistances.rows.find((r) => r.kind === 'granted');
    expect(row).toMatchObject({ slot: 'Relic', label: 'Test Aura', band: 'permanent' });
    // The energy it reserves is the one reason to discount the row, so it says so.
    expect(row?.note).toBe('granted by Test Relic, toggle, reserves 150% energy');
  });

  it('counts every granting item, because two copies of a component are two buffs', () => {
    // In-game behaviour, and the opposite of the set-bonus rule where a second
    // copy of a member adds nothing. Not derivable from the data either way.
    expect(twice.grantedSkills.filter((g) => g.skill === 'Test Aura').map((g) => g.counted)).toEqual([true, true]);
    expect(twice.damage.ranked.find((d) => d.key === 'cold')?.percent).toBe(36 + 125 * 2);
    expect(twice.resistances.permanent.cold).toBe(40);
    expect(twice.resistances.rows.filter((r) => r.kind === 'granted')).toHaveLength(2);
  });

  it('leaves the conditional kinds named but unsummed', () => {
    const nova = agg.grantedSkills.find((g) => g.skill === 'Test Nova');
    expect(nova).toMatchObject({ item: 'Test Helm', counted: false });
    // The proc's 280 flat cold is an attack, and stays out of the pools.
    expect(agg.damage.ranked.find((d) => d.key === 'cold')?.flat ?? 0).toBe(0);
    expect(agg.exclusions.join('\n')).toMatch(/item-granted procs, activated skills and pet skills/);
  });
});

describe('sustain: attack damage converted to health', () => {
  const GLOVES = 'records/items/gloves.dbr';
  const SEAL = 'records/items/materia/inscription.dbr';
  const FOX = 'records/skills/devotion/fox1.dbr';
  const DRAIN = 'records/skills/class/drain1.dbr';

  const db = stubDb({
    items: {
      [GLOVES]: item(GLOVES, { name: 'Test Gloves', slot: 'ArmorProtective_Hands', stats: { defensiveProtection: 300 } }),
      [SEAL]: item(SEAL, { name: 'Test Inscription', slot: 'ItemRelic', stats: { offensiveLifeLeechMin: 5 } }),
    },
    skills: {
      [FOX]: skill(FOX, { name: 'Test Fox', maxLevel: 1, stats: { offensiveLifeLeechMin: 6 } }),
      // An attack skill's own leech applies to that skill's whole damage and
      // scopes to it — it must land on the skill's row, never on the character.
      [DRAIN]: skill(DRAIN, {
        name: 'Test Drain',
        class: 'Skill_AttackRadius',
        stats: { weaponDamagePct: [60, 70], offensiveLifeLeechMin: [12, 15] },
      }),
    },
  });

  const equipment: (EquippedItem | null)[] = Array.from({ length: 12 }, () => null);
  equipment[5] = instance({ baseName: GLOVES, relicName: SEAL });
  const agg = aggregateCharacter(
    save({ equipment, devotions: [characterSkill(FOX, 1)], skills: [characterSkill(DRAIN, 2)] }),
    db,
  );

  it('sums the global figure and attributes every source, like a resistance', () => {
    expect(agg.defense.lifeLeechPercent).toBe(11);
    expect(agg.defense.lifeLeechSources).toEqual([
      { slot: 'Hands', label: 'Test Inscription', value: 5 },
      { slot: 'Devotion', label: 'Test Fox', value: 6 },
    ]);
  });

  it('keeps an attack skill’s own leech on the skill, at its rank, and out of the global figure', () => {
    const row = agg.damage.skillDamage.find((s) => s.skill === 'Test Drain');
    expect(row?.lifeLeechPercent).toBe(15);
    expect(agg.defense.lifeLeechSources.map((s) => s.label)).not.toContain('Test Drain');
  });
});

describe.skipIf(!haveGameInstall() || !haveSaves())(
  `aggregates vs the live save (${haveGameInstall() && haveSaves() ? 'live' : MISSING_SAVES_MESSAGE})`,
  () => {
    const TIMEOUT = 180_000;

    it('bands, ranks and profiles a real character', { timeout: TIMEOUT }, async () => {
      const db = await gameDb();
      const path = characterSavePath(primaryCharacter());
      const agg = aggregateCharacter(parseGdc(readFileSync(path), { path }), db);

      // Every equipped slot with resistances on it should be attributable.
      expect(agg.resistances.rows.some((r) => r.kind === 'base')).toBe(true);
      expect(agg.resistances.rows.some((r) => r.kind === 'augment')).toBe(true);
      expect(agg.resistances.rows.some((r) => r.kind === 'devotion')).toBe(true);

      // A skill row carries its *effective* rank — invested points plus gear
      // `+skills` — as a note. The exact number moves every time the character
      // respecs or re-gears (it was 12 when this test was written, 2 after the
      // 2026-08-10 advice run was acted on), so pin the mechanism, not the
      // count: ranks are stated, and stated with a number. Other rows note
      // other things — an affix's roll, for one — and are not this rule's
      // business.
      const rankNotes = agg.resistances.rows.map((r) => r.note).filter((n) => n?.startsWith('rank'));
      expect(rankNotes.length).toBeGreaterThan(0);
      for (const note of rankNotes) expect(note).toMatch(/^rank \d+$/);

      // The damage profile reads as a build: types the character actually
      // invests in, ordered by the `+%` it has committed to them and broken by
      // flat. Which types lead is the player's business and changes with every
      // respec, so the order is checked against its own rule rather than
      // against a remembered pair.
      expect(agg.damage.ranked.length).toBeGreaterThan(0);
      const order = agg.damage.ranked.map((d) => [d.percent, d.flat] as const);
      expect([...order].sort((a, b) => b[0] - a[0] || b[1] - a[1])).toEqual(order);
      for (const entry of agg.damage.ranked) {
        expect(entry.percent > 0 || entry.flat > 0, entry.key).toBe(true);
      }

      // Resistance reduction is not defence — the sign trap. Whatever supplies
      // it must appear on that side of the ledger and on no other.
      const rrSources = new Set(agg.damage.resistReduction.map((rr) => rr.source));
      expect(rrSources.size).toBeGreaterThan(0);
      for (const source of rrSources) {
        expect(agg.resistances.rows.some((r) => r.label === source), source).toBe(false);
      }

      // Nothing may render as a raw record path.
      const labels = [
        ...agg.resistances.rows.map((r) => r.label),
        ...agg.ranks.map((r) => r.name),
        ...agg.damage.resistReduction.map((r) => r.source),
      ];
      expect(labels.filter((l) => l.includes('.dbr'))).toEqual([]);
    });

    it('bands a maintainable buff apart from the permanent ones', { timeout: TIMEOUT }, async () => {
      const db = await gameDb();
      // The band exists to hold buffs that are only up while the player keeps
      // them up. *Which* character has one is a fact about how the saves have
      // been played — the one this test used to name was respecced out of the
      // mastery granting it, and the buff moved to an alt — so the band is
      // searched for, and its contract checked wherever it is found.
      let found = 0;
      for (const name of CHARACTERS) {
        const path = characterSavePath(name);
        const agg = aggregateCharacter(parseGdc(readFileSync(path), { path }), db);
        if (agg.maintained.length === 0) continue;
        found++;

        const maintained = new Set(agg.maintained.map((m) => m.name));
        for (const buff of maintained) expect(buff, name).not.toMatch(/\.dbr$/);
        // A resistance the character only has while that buff is up must be
        // banded with it, never summed into the permanent total.
        for (const row of agg.resistances.rows) {
          if (maintained.has(row.label)) expect(row.band, `${name}: ${row.label}`).toBe('maintainable');
        }
      }
      expect(found, 'no character on this machine has a maintainable buff').toBeGreaterThan(0);
    });

    it('types the damage path: conversion applied, composition whole, attack skills typed', { timeout: TIMEOUT }, async () => {
      const db = await gameDb();
      const path = characterSavePath(primaryCharacter());
      const agg = aggregateCharacter(parseGdc(readFileSync(path), { path }), db);

      // A conversion is typed, scoped, and expands its in-type to real damage
      // keys — `Elemental` is the three, and every pair names types the
      // vocabulary knows. Which conversions a character carries is gear, and
      // this one's swapped: it was pinned to a specific pair of epaulets until
      // the loadout moved on.
      for (const c of agg.damage.conversions) {
        expect(['global', 'skill'], `${c.from}→${c.to}`).toContain(c.scope);
        expect(c.fromKeys.length, `${c.from}→${c.to}`).toBeGreaterThan(0);
        if (c.from === 'Elemental') expect(c.fromKeys).toEqual(['fire', 'cold', 'lightning']);
      }

      // Shares are percentages of one whole, led by a type the profile ranks.
      const shares = agg.damage.weaponAttack.composition.reduce((n, s) => n + s.share, 0);
      expect(shares).toBeGreaterThanOrEqual(98);
      expect(shares).toBeLessThanOrEqual(102);
      const lead = agg.damage.weaponAttack.composition[0]?.key;
      expect(agg.damage.ranked.map((d) => d.key)).toContain(lead);

      // Every invested attack skill gets typed, the main attack among them, and
      // it is named rather than left as the record it came from.
      expect(agg.damage.skillDamage.length).toBeGreaterThan(2);
      const mainAttack = agg.damage.weaponAttack.mainAttack;
      expect(mainAttack).toBeTruthy();
      expect(mainAttack).not.toMatch(/\.dbr$/);
      const main = agg.damage.skillDamage.find((s) => s.skill === mainAttack);
      expect(main, `${mainAttack} missing from skillDamage`).toBeDefined();
      expect(main!.weaponDamagePct).toBeGreaterThan(0);
    });

    it('proves every equipped item satisfiable — the wearing-it invariant', { timeout: TIMEOUT }, async () => {
      const db = await gameDb();
      for (const name of CHARACTERS) {
        const path = characterSavePath(name);
        const agg = aggregateCharacter(parseGdc(readFileSync(path), { path }), db);

        // Attribute totals must sit above the save's base — gear and mastery
        // bars always add something on a levelled character.
        for (const key of ['physique', 'cunning', 'spirit'] as const) {
          expect(agg.attributes[key].total).toBeGreaterThanOrEqual(agg.attributes[key].base);
        }

        // The character is wearing all of it, so every check must hold. A
        // failure here means the requirement model (equation routing, stat
        // count, reduction scoping, attribute totals) is wrong — this is the
        // end-to-end gate on the whole layer.
        for (const entry of agg.equippedRequirements) {
          expect(
            entry.check.meets,
            `${name} ${entry.slot} (${entry.item}): ${JSON.stringify(entry.check.gaps)}`,
          ).toBe(true);
        }
      }
    });

    it('wielding it proves it: a dual-wielding character has a named enabler', { timeout: TIMEOUT }, async () => {
      const db = await gameDb();
      for (const name of CHARACTERS) {
        const path = characterSavePath(name);
        const agg = aggregateCharacter(parseGdc(readFileSync(path), { path }), db);
        // The game let the character equip this loadout, so a dual-wield mode
        // with no enabler is a model gap, not a character state.
        if (agg.wielding.mode.startsWith('dual-wield')) {
          expect(agg.wielding.enablers.length, `${name}: ${agg.wielding.mode} with no enabler`).toBeGreaterThan(0);
        }
      }

      // And the case with teeth, found rather than named: a character actually
      // holding two weapons. Its enablers are named — the specific one was
      // written down here and went stale the first time the character respecced
      // into a different mastery — and because it really is dual-wielding, the
      // conditional stats count and the exclusion line must not appear.
      for (const name of CHARACTERS) {
        const path = characterSavePath(name);
        const agg = aggregateCharacter(parseGdc(readFileSync(path), { path }), db);
        if (!agg.wielding.mode.startsWith('dual-wield')) continue;

        expect(agg.wielding.enablers.length, name).toBeGreaterThan(0);
        for (const e of agg.wielding.enablers) expect(e.name, name).not.toMatch(/\.dbr$/);
        expect(agg.exclusions.some((line) => line.includes('dual-wield-only')), name).toBe(false);
        break;
      }
    });

    it('scales the totals by difficulty without touching the raw sums', { timeout: TIMEOUT }, async () => {
      const db = await gameDb();
      const path = characterSavePath(primaryCharacter());
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
