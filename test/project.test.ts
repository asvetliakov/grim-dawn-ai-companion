import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { adviseEnvelopeSchema } from '../src/core/ai/envelope.js';
import { projectPlan, projectVerdicts, type ProjectionInput } from '../src/core/ai/project.js';
import { candidateProjections } from '../src/core/context/projections.js';
import { selectCandidates, type CandidateContext } from '../src/core/context/filters.js';
import type { AdvisorPlan } from '../src/core/ai/provider.js';
import { buildContextDoc } from '../src/core/context/builder.js';
import type { DbItem, DbSkill, GameDb } from '@grimdawn/core/db/types';
import { aggregateCharacter } from '../src/core/mechanics/aggregate.js';
import { RESIST_COLUMNS } from '../src/core/mechanics/stats.js';
import { resolveCharacter, resolveItem, type AccountFiles, type ResolvedItem } from '@grimdawn/core/resolve';
import { parseGdc } from '@grimdawn/core/save/gdc';
import { parseFormulasFile, parseReagents, parseTransferStash } from '@grimdawn/core/save/gst';
import {
  EQUIP_SLOT_NAMES,
  type CharacterSave,
  type CharacterSkill,
  type EquippedItem,
  type ItemInstance,
  type ItemPosition,
  type PositionedItem,
} from '@grimdawn/core/save/types';
import {
  FORMULAS_PATH,
  MISSING_GAME_MESSAGE,
  MISSING_SAVES_MESSAGE,
  REAGENTS_PATH,
  TRANSFER_STASH_PATH,
  gameDb,
  haveGameInstall,
  haveSaves,
  snapshotCharacterSave,
  snapshotSharedSave,
} from './paths.js';

// ---------------------------------------------------------------------------
// The same synthetic world the mechanics tests use, plus a dossier index
// ---------------------------------------------------------------------------

function skill(record: string, over: Partial<DbSkill> = {}): DbSkill {
  return { record, class: 'Skill_Passive', stats: {}, ...over };
}

function item(record: string, over: Partial<DbItem> = {}): DbItem {
  return { record, name: record, levelReq: 1, rarity: 'Common', slot: 'x', iconPath: '', stats: {}, ...over };
}

function stubDb(world: { items?: Record<string, DbItem>; skills?: Record<string, DbSkill> }): GameDb {
  return {
    gameVersion: 'test',
    getItem: (r) => world.items?.[r],
    getAffixName: () => undefined,
    knowsAffix: () => false,
    getAffix: () => undefined,
    getSkill: (r) => world.skills?.[r],
    getSet: () => undefined,
    skillName: (r) => world.skills?.[r]?.name,
    skillClass: () => undefined,
    masteryNumber: () => undefined,
    difficultyPenalty: () => ({}),
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

// The world: a worn helm, a better one in the bag (which also carries +2 to a
// passive), a ring worn in Ring 2, a shoulder piece carrying a component, a
// sword in the main hand, a component + augment in the dictionary, and a
// maintainable buff for the band tests.
const HELM = 'records/items/helm.dbr';
const BETTER_HELM = 'records/items/betterhelm.dbr';
const RING = 'records/items/ring.dbr';
const SHOULDERS = 'records/items/shoulders.dbr';
const WEAPON = 'records/items/sword.dbr';
const COMPONENT = 'records/items/materia/comp.dbr';
const AUGMENT = 'records/items/materia/aug.dbr';
const PASSIVE = 'records/skills/playerclass04/passive1.dbr';
const MAINT_BUFF = 'records/skills/playerclass04/buff1.dbr';

const db = stubDb({
  items: {
    // The old helm carries the world's only leech, so replacing it costs sustain.
    // …and a level-requirement reduction, so the equip-time check of what
    // replaces it differs from the as-dressed check.
    [HELM]: item(HELM, {
      name: 'Old Helm',
      slot: 'ArmorProtective_Head',
      stats: { defensiveFire: 20, offensiveLifeLeechMin: 4, characterLevelReqReduction: 12 },
    }),
    [BETTER_HELM]: item(BETTER_HELM, {
      name: 'Better Helm',
      slot: 'ArmorProtective_Head',
      levelReq: 60,
      rarity: 'Epic',
      stats: {
        defensiveFire: 35,
        offensiveColdModifier: 40,
        augmentSkillName1: PASSIVE,
        augmentSkillLevel1: 2,
      },
    }),
    [RING]: item(RING, { name: 'Plain Ring', slot: 'ArmorJewelry_Ring', stats: { defensivePierce: 10 } }),
    [SHOULDERS]: item(SHOULDERS, { name: 'Spikes', slot: 'ArmorProtective_Shoulders', stats: { defensiveChaos: 25 } }),
    [WEAPON]: item(WEAPON, {
      name: 'Test Sword',
      slot: 'WeaponMelee_Sword1h',
      stats: { offensivePhysicalMin: 10, offensivePhysicalMax: 20 },
    }),
    [COMPONENT]: item(COMPONENT, { name: 'Test Seal', slot: 'ItemRelic', stats: { defensiveAether: 12 } }),
    [AUGMENT]: item(AUGMENT, { name: 'Test Powder', slot: 'ItemEnchantment', stats: { defensiveLife: 15 } }),
  },
  skills: {
    [PASSIVE]: skill(PASSIVE, {
      name: 'Test Poise',
      maxLevel: 12,
      ultimateLevel: 22,
      // Rank-indexed: rank 2 → 20 Cold Resistance, rank 4 → 40.
      stats: { defensiveCold: [10, 20, 30, 40, 50], offensivePhysicalModifier: [5, 10, 15, 20, 25] },
    }),
    [MAINT_BUFF]: skill(MAINT_BUFF, {
      name: 'Test Ward',
      class: 'Skill_BuffSelfDuration',
      duration: 30,
      cooldown: 5,
      stats: { defensiveFire: 10 },
    }),
  },
});

function resolved(inst: ItemInstance, source: 'equipped' | 'inventory', location: string, position: ItemPosition): ResolvedItem {
  return resolveItem(inst, db, source, location, undefined, position);
}

interface WorldOptions {
  skills?: CharacterSkill[];
  /** Hold the sword in weapon set 2 instead, with that set active. */
  alternateSet?: boolean;
}

/** A save wearing the old helm, the ring and a sword, with the better helm in bag 1. */
function world(over: WorldOptions = {}): { input: ProjectionInput; save: CharacterSave } {
  const bagHelm = { ...instance({ baseName: BETTER_HELM, seed: 7 }), x: 0, y: 0 };
  const sword = instance({ baseName: WEAPON, seed: 11 });
  const theSave = save({
    equipment: (() => {
      const eq: (EquippedItem | null)[] = Array.from({ length: 12 }, () => null);
      eq[0] = instance({ baseName: HELM });
      eq[7] = instance({ baseName: RING, seed: 3 });
      eq[9] = instance({ baseName: SHOULDERS, relicName: COMPONENT });
      return eq;
    })(),
    weaponSet1: over.alternateSet ? [null, null] : [sword, null],
    weaponSet2: over.alternateSet ? [sword, null] : [null, null],
    alternateWeaponSetActive: over.alternateSet ?? false,
    inventorySacks: [[bagHelm]],
    skills: over.skills ?? [characterSkill(PASSIVE, 2)],
  });
  const account: AccountFiles = {};
  const itemsById = new Map<string, ResolvedItem>([
    ['cand-helm', resolved(bagHelm, 'inventory', 'bag 1 (0,0)', { kind: 'inventory', sack: 0, x: 0, y: 0 })],
    ['worn-ring', resolved(theSave.equipment[7]!, 'equipped', 'Ring 2', { kind: 'equipment', slot: 7 })],
    ['worn-shoulders', resolved(theSave.equipment[9]!, 'equipped', 'Shoulders', { kind: 'equipment', slot: 9 })],
  ]);
  const socketablesById = new Map<string, { record: string }>([
    ['s-comp', { record: COMPONENT }],
    ['s-aug', { record: AUGMENT }],
  ]);
  return {
    save: theSave,
    input: { save: theSave, account, db, difficulty: 'Ultimate', itemsById, socketablesById },
  };
}

const plan = (over: Partial<AdvisorPlan>): AdvisorPlan => ({
  verdicts: [],
  hold: [],
  sell: [],
  ...over,
});

const resist = (p: NonNullable<ReturnType<typeof projectPlan>>, label: string) =>
  p.resistances.find((r) => r.label === label)!;

describe('projectPlan', () => {
  it('moves a resistance and a damage +% when an EQUIP replaces a worn item', () => {
    const { input } = world();
    const p = projectPlan(
      plan({ verdicts: [{ slot: 'Head', itemId: '', verdict: 'EQUIP', targetId: 'cand-helm', reason: '' }] }),
      input,
    )!;
    expect(resist(p, 'Fire')).toMatchObject({ before: 20, after: 35 });
    const cold = p.damage.find((d) => d.key === 'cold')!;
    expect(cold.percentBefore).toBe(0);
    expect(cold.percentAfter).toBe(40);
    expect(p.skipped).toEqual([]);
  });

  it('shifts an effective skill rank through the equipped gear’s +skills — the headline case', () => {
    const { input } = world();
    const p = projectPlan(
      plan({ verdicts: [{ slot: 'Head', itemId: '', verdict: 'EQUIP', targetId: 'cand-helm', reason: '' }] }),
      input,
    )!;
    // +2 to Test Poise: rank 2 → 4, and the per-rank arrays move with it.
    expect(p.skillRanks).toEqual([{ skill: 'Test Poise', before: 2, after: 4 }]);
    expect(resist(p, 'Cold')).toMatchObject({ before: 20, after: 40 });
    const physical = p.damage.find((d) => d.key === 'physical')!;
    expect(physical.percentBefore).toBe(10);
    expect(physical.percentAfter).toBe(20);
  });

  it('installs a component and an augment through socket verdicts and fits', () => {
    const { input } = world();
    const p = projectPlan(
      plan({
        verdicts: [
          {
            slot: 'Head',
            itemId: '',
            verdict: 'ADD-COMPONENT',
            targetId: 's-comp',
            fits: [{ kind: 'augment', id: 's-aug' }],
            reason: '',
          },
        ],
      }),
      input,
    )!;
    // Aether starts at 12: the worn shoulders already carry the same component.
    expect(resist(p, 'Aether')).toMatchObject({ before: 12, after: 24 });
    expect(resist(p, 'Vitality')).toMatchObject({ before: 0, after: 15 });
    expect(p.notes.some((n) => n.includes('completion bonus'))).toBe(true);
  });

  it('does not double-count a worn item equipped into its sibling slot', () => {
    const { input } = world();
    const p = projectPlan(
      plan({ verdicts: [{ slot: 'Ring 1', itemId: '', verdict: 'EQUIP', targetId: 'worn-ring', reason: '' }] }),
      input,
    )!;
    // The ring moved; it did not clone itself.
    expect(resist(p, 'Pierce')).toMatchObject({ before: 10, after: 10 });
  });

  it('removes a worn extraction host from the loadout', () => {
    const { input } = world();
    const p = projectPlan(
      plan({
        verdicts: [
          {
            slot: 'Head',
            itemId: '',
            verdict: 'ADD-COMPONENT',
            targetId: 's-comp',
            componentFrom: 'worn-shoulders',
            reason: '',
          },
        ],
      }),
      input,
    )!;
    expect(resist(p, 'Chaos')).toMatchObject({ before: 25, after: 0 });
    expect(p.notes.some((n) => n.includes('destroys its host'))).toBe(true);
  });

  it('degrades unknown ids, CRAFT and unrecognized slots to skipped — never a throw', () => {
    const { input } = world();
    const p = projectPlan(
      plan({
        verdicts: [
          { slot: 'Head', itemId: '', verdict: 'EQUIP', targetId: 'zzz999', reason: '' },
          { slot: 'Chest', itemId: '', verdict: 'CRAFT', target: 'Some Blueprint', reason: '' },
          { slot: 'Hat Rack', itemId: '', verdict: 'KEEP', reason: '' },
        ],
      }),
      input,
    )!;
    expect(p.skipped.map((s) => s.verdict)).toEqual(['EQUIP', 'CRAFT', 'KEEP']);
    expect(resist(p, 'Fire')).toMatchObject({ before: 20, after: 20 });
  });

  it('notes a change to the inactive weapon set and leaves the figures alone', () => {
    const { input } = world();
    const p = projectPlan(
      plan({
        verdicts: [{ slot: 'Weapon set 2 main', itemId: '', verdict: 'EQUIP', targetId: 'cand-helm', reason: '' }],
      }),
      input,
    )!;
    expect(p.notes.some((n) => n.includes('inactive weapon set'))).toBe(true);
    // The helm's +skills did not land: the held set is set 1.
    expect(p.skillRanks).toEqual([]);
  });

  it('says where the model’s own resistance projection disagrees, without a warning', () => {
    const { input } = world();
    const p = projectPlan(
      plan({
        verdicts: [{ slot: 'Head', itemId: '', verdict: 'EQUIP', targetId: 'cand-helm', reason: '' }],
        projectedResistances: { Fire: 60 },
      }),
      input,
    )!;
    expect(p.notes.some((n) => n.includes('the model projected Fire Resistance at 60'))).toBe(true);
  });

  it('resolves a Main hand alias against the active weapon set — the opus case, pinned', () => {
    const { input } = world();
    const p = projectPlan(
      plan({ verdicts: [{ slot: 'Main hand', itemId: '', verdict: 'BUY-AUGMENT', targetId: 's-aug', reason: '' }] }),
      input,
    )!;
    // The augment landed on weaponSet1[0] instead of the verdict being skipped
    // as `unrecognized slot label` — which is what cost the live run 20 real
    // points of computed Chaos Resistance.
    expect(p.skipped).toEqual([]);
    expect(resist(p, 'Vitality')).toMatchObject({ before: 0, after: 15 });
  });

  it('resolves the alias to set 2 when the alternate set is the held one', () => {
    const { input } = world({ alternateSet: true });
    const p = projectPlan(
      plan({ verdicts: [{ slot: 'Off hand', itemId: '', verdict: 'BUY-AUGMENT', targetId: 's-aug', reason: '' }] }),
      input,
    )!;
    // `Off hand` means set 2's off hand here — empty, so the skip names the
    // right slot rather than falling back to set 1.
    expect(p.skipped).toEqual([
      { slot: 'Off hand', verdict: 'BUY-AUGMENT', reason: 'the slot is empty in the loadout the run saw' },
    ]);
    const applied = projectPlan(
      plan({ verdicts: [{ slot: 'mainhand', itemId: '', verdict: 'BUY-AUGMENT', targetId: 's-aug', reason: '' }] }),
      input,
    )!;
    expect(applied.skipped).toEqual([]);
    expect(applied.notes.some((n) => n.includes('inactive weapon set'))).toBe(false);
    expect(resist(applied, 'Vitality')).toMatchObject({ before: 0, after: 15 });
  });

  it('accepts a model figure stating the permanent band, and notes one matching neither band', () => {
    const { input } = world({ skills: [characterSkill(PASSIVE, 2), characterSkill(MAINT_BUFF, 1)] });
    const verdicts = [{ slot: 'Head', itemId: '', verdict: 'EQUIP' as const, targetId: 'cand-helm', reason: '' }];

    // Effective Fire after: 35 (better helm) + 10 (maintainable ward) = 45;
    // the permanent band is 35. A model deliberately reporting the permanent
    // band is making a reporting choice, not an arithmetic error.
    const quiet = projectPlan(plan({ verdicts, projectedResistances: { Fire: 35 } }), input)!;
    expect(resist(quiet, 'Fire')).toMatchObject({ before: 30, after: 45, afterPermanent: 35 });
    expect(quiet.notes.some((n) => n.includes('the model projected Fire'))).toBe(false);

    const noisy = projectPlan(plan({ verdicts, projectedResistances: { Fire: 60 } }), input)!;
    expect(noisy.notes.some((n) => n.includes('the model projected Fire Resistance at 60'))).toBe(true);
    expect(noisy.notes.some((n) => n.includes('permanent-band'))).toBe(true);
  });

  it('carries the payload index and the defense block', () => {
    const { input } = world();
    const p = projectPlan(
      plan({ verdicts: [{ slot: 'Head', itemId: '', verdict: 'EQUIP', targetId: 'cand-helm', reason: '' }] }),
      input,
    )!;
    // Sword flat physical midpoint 15; Test Poise `+% Physical` is 10 at rank 2
    // and 20 at rank 4 (the helm's +2): 15 × 1.1 = 16.5 → 17, 15 × 1.2 = 18.
    expect(p.payload).toEqual({ before: 17, after: 18 });
    const d = p.defense!;
    expect(d).toBeDefined();
    // No attribute stats anywhere in this world: the totals hold still, which
    // is itself the assertion — the block reports, it does not invent.
    expect(d.attributes.cunning.before).toBe(d.attributes.cunning.after);
    expect(d.armorMean.before).toBe(d.armorMean.after);
    expect(d.absorption).toEqual({ before: 70, after: 70 });
    // The outgoing helm's leech leaves with it — a defensive cost the block
    // states rather than leaving to the prose.
    expect(d.sustain).toEqual({ before: 4, after: 0 });
  });

  it('never mutates the save it was given', () => {
    const { input, save: original } = world();
    const snapshot = JSON.stringify(original);
    projectPlan(
      plan({
        verdicts: [
          { slot: 'Head', itemId: '', verdict: 'EQUIP', targetId: 'cand-helm', reason: '' },
          { slot: 'Shoulders', itemId: '', verdict: 'RE-AUGMENT', targetId: 's-aug', reason: '' },
        ],
      }),
      input,
    );
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

describe('envelope round-trip', () => {
  const base = {
    character: 'Test',
    generatedAt: '2026-08-10T00:00:00.000Z',
    gameVersion: 'v1',
    provider: 'mock',
    model: null,
    effort: null,
    calls: 1,
    usage: { inputTokens: 1, outputTokens: 1 },
    durationMs: 1,
    warnings: [],
    firstWarnings: [],
    revised: false,
    revisionRejected: false,
    answer: 'x',
    plan: null,
    verdictRows: [],
    itemNames: {},
    socketableNames: {},
  };

  it('validates a stored envelope with and without a projection', () => {
    expect(adviseEnvelopeSchema.safeParse(base).success).toBe(true);
    // A Stage 8 projection: no afterPermanent, no payload, no defense. Those
    // fields are optional precisely so this file still opens.
    const projection = {
      resistances: [{ label: 'Fire', before: 20, after: 35, capAfter: 80 }],
      speeds: [{ key: 'attack', label: 'Attack', before: 100, after: 100 }],
      damage: [
        { key: 'cold', label: 'Cold', overTime: false, percentBefore: 0, percentAfter: 40, flatBefore: 0, flatAfter: 0 },
      ],
      totalDamagePercent: { before: 0, after: 0 },
      skillRanks: [{ skill: 'Test Poise', before: 2, after: 4 }],
      skipped: [],
      notes: [],
    };
    const parsed = adviseEnvelopeSchema.safeParse({ ...base, projection });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.projection?.resistances[0]?.after).toBe(35);
  });

  it('validates a projection carrying the Stage 8B bands, payload and defense block', () => {
    const { input } = world();
    const projection = projectPlan(
      plan({ verdicts: [{ slot: 'Head', itemId: '', verdict: 'EQUIP', targetId: 'cand-helm', reason: '' }] }),
      input,
    )!;
    const parsed = adviseEnvelopeSchema.safeParse({ ...base, projection });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.projection?.resistances[0]?.afterPermanent).toBeDefined();
      expect(parsed.data.projection?.payload).toBeDefined();
      expect(parsed.data.projection?.defense).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// The audit: projectPlan against an independently mutated live save
// ---------------------------------------------------------------------------

/** Wearable template classes → the equipment slot they go in. */
const CLASS_TO_SLOT: Readonly<Record<string, string>> = {
  ArmorProtective_Head: 'Head',
  ArmorJewelry_Amulet: 'Neck',
  ArmorProtective_Chest: 'Chest',
  ArmorProtective_Legs: 'Legs',
  ArmorProtective_Feet: 'Feet',
  ArmorProtective_Hands: 'Hands',
  ArmorJewelry_Ring: 'Ring 1',
  ArmorProtective_Waist: 'Belt',
  ArmorProtective_Shoulders: 'Shoulders',
  ArmorJewelry_Medal: 'Medal',
};

const canRunLive = haveGameInstall() && haveSaves();
const liveSkipReason = !haveGameInstall() ? MISSING_GAME_MESSAGE : MISSING_SAVES_MESSAGE;

describe.skipIf(!canRunLive)(`projection vs an independent mutation (${canRunLive ? 'live' : liveSkipReason})`, () => {
  it('agrees with a hand-mutated save on resistances, speeds, damage and payload', { timeout: 180_000 }, async () => {
    const db = await gameDb();
    const liveSave = parseGdc(readFileSync(snapshotCharacterSave('_Suchka')));
    const account: AccountFiles = {
      stash: parseTransferStash(readFileSync(snapshotSharedSave(TRANSFER_STASH_PATH))),
      formulas: parseFormulasFile(readFileSync(snapshotSharedSave(FORMULAS_PATH))),
      materials: parseReagents(readFileSync(snapshotSharedSave(REAGENTS_PATH))),
    };
    const doc = buildContextDoc({
      save: liveSave,
      aggregate: aggregateCharacter(liveSave, db, liveSave.difficulty),
      resolved: resolveCharacter(liveSave, account, db),
      db,
    });

    // Any real bag candidate that maps onto an equipment slot will do — the
    // point is that two *different* mutation code paths agree, not which item.
    const picked = [...doc.itemsById].find(
      ([, it]) => it.position.kind === 'inventory' && CLASS_TO_SLOT[it.base?.slot ?? ''] !== undefined,
    );
    expect(picked, 'no bag candidate mapping to an equipment slot').toBeDefined();
    const [id, candidate] = picked!;
    const slotName = CLASS_TO_SLOT[candidate.base!.slot]!;
    const slotIndex = EQUIP_SLOT_NAMES.indexOf(slotName);

    const projection = projectPlan(
      plan({ verdicts: [{ slot: slotName, itemId: '', verdict: 'EQUIP', targetId: id, reason: '' }] }),
      { save: liveSave, account, db, difficulty: liveSave.difficulty, itemsById: doc.itemsById, socketablesById: doc.socketablesById },
    )!;
    expect(projection.skipped).toEqual([]);

    // The independent mutation: test code writes the equipment slot itself,
    // through none of projectPlan's machinery.
    const mutated = structuredClone(liveSave);
    const pos = candidate.position as { kind: 'inventory'; sack: number; x: number; y: number };
    const raw = mutated.inventorySacks[pos.sack]!.find(
      (it) => it.x === pos.x && it.y === pos.y && it.baseName === candidate.record,
    )!;
    expect(raw).toBeDefined();
    const { x: _x, y: _y, ...rest } = raw;
    mutated.equipment[slotIndex] = { ...rest, attached: true };
    const after = aggregateCharacter(mutated, db, liveSave.difficulty);

    const round1 = (n: number): number => Math.round(n * 10) / 10;
    for (const column of RESIST_COLUMNS) {
      const row = projection.resistances.find((r) => r.label === column.label)!;
      expect(round1(after.resistances.effective[column.key] ?? 0), `${column.label} Resistance`).toBe(row.after);
    }
    expect(projection.speeds.find((s) => s.key === 'attack')?.after).toBe(round1(after.speed.attack.percent));
    expect(projection.speeds.find((s) => s.key === 'cast')?.after).toBe(round1(after.speed.cast.percent));
    for (const entry of after.damage.ranked) {
      const row = projection.damage.find((d) => d.key === entry.key);
      expect(row?.percentAfter, `${entry.label} +%`).toBe(entry.percent);
      expect(row?.flatAfter, `${entry.label} flat`).toBe(entry.flat);
    }
    expect(projection.payload?.after).toBe(after.damage.payloadIndex);
  });
});

// ---------------------------------------------------------------------------
// Candidate projections: the swap arithmetic §7 prints under each candidate
// ---------------------------------------------------------------------------

describe('candidate projections', () => {
  const WORSE_HELM = 'records/items/worsehelm.dbr';
  const BETTER_RING = 'records/items/betterring.dbr';
  const GREATAXE = 'records/items/greataxe.dbr';
  const SHIELD = 'records/items/shield.dbr';

  const sceneDb = stubDb({
    items: {
      [HELM]: db.getItem(HELM)!,
      [BETTER_HELM]: db.getItem(BETTER_HELM)!,
      [RING]: db.getItem(RING)!,
      [SHOULDERS]: db.getItem(SHOULDERS)!,
      [WEAPON]: db.getItem(WEAPON)!,
      [COMPONENT]: db.getItem(COMPONENT)!,
      [AUGMENT]: db.getItem(AUGMENT)!,
      // Strictly worse on every tracked figure, and carrying nothing the projection cannot see.
      [WORSE_HELM]: item(WORSE_HELM, { name: 'Worse Helm', slot: 'ArmorProtective_Head', rarity: 'Epic', levelReq: 50, stats: { defensiveFire: 5 } }),
      [BETTER_RING]: item(BETTER_RING, { name: 'Better Ring', slot: 'ArmorJewelry_Ring', rarity: 'Epic', levelReq: 50, stats: { defensivePierce: 20 } }),
      [GREATAXE]: item(GREATAXE, {
        name: 'Test Greataxe',
        slot: 'WeaponMelee_Axe2h',
        rarity: 'Epic',
        levelReq: 50,
        stats: { offensivePhysicalMin: 40, offensivePhysicalMax: 60 },
      }),
      [SHIELD]: item(SHIELD, { name: 'Test Shield', slot: 'WeaponArmor_Shield', rarity: 'Epic', levelReq: 50, stats: { defensiveBlockChance: 20 } }),
    },
    skills: { [PASSIVE]: db.getSkill(PASSIVE)!, [MAINT_BUFF]: db.getSkill(MAINT_BUFF)! },
  });

  interface Scene {
    bag: PositionedItem[];
    main?: EquippedItem | null;
    off?: EquippedItem | null;
  }

  /** A save with the old helm and the plain ring worn, the given bag, and the given hands. */
  function scene(over: Scene) {
    const theSave = save({
      equipment: (() => {
        const eq: (EquippedItem | null)[] = Array.from({ length: 12 }, () => null);
        eq[0] = instance({ baseName: HELM });
        eq[7] = instance({ baseName: RING, seed: 3 });
        return eq;
      })(),
      weaponSet1: [over.main === undefined ? instance({ baseName: WEAPON, seed: 11 }) : over.main, over.off ?? null],
      inventorySacks: [over.bag],
      skills: [characterSkill(PASSIVE, 2)],
    });
    const account: AccountFiles = {};
    const resolved = resolveCharacter(theSave, account, sceneDb);
    const aggregate = aggregateCharacter(theSave, sceneDb);
    const ctx: CandidateContext = {
      level: aggregate.level,
      standing: {
        level: aggregate.level,
        attributes: {
          physique: aggregate.attributes.physique.total,
          cunning: aggregate.attributes.cunning.total,
          spirit: aggregate.attributes.spirit.total,
        },
        reductions: aggregate.requirementReductions,
      },
      shortfalls: new Set(RESIST_COLUMNS.filter((c) => (aggregate.resistances.effective[c.key] ?? 0) < 80).map((c) => c.key)),
      topDamage: new Set(aggregate.damage.ranked.slice(0, 2).map((e) => e.key)),
      unspentPoints: 0,
      attributePerPoint: { physique: 8, cunning: 8, spirit: 8 },
      perGroup: 40,
    };
    const candidates = [...selectCandidates(resolved.items, ctx).byGroup.values()].flat();
    const projections = candidateProjections(candidates, {
      save: theSave,
      account,
      db: sceneDb,
      aggregate,
      resolved,
      ids: new Map(resolved.items.map((i) => [i, i.id])),
      obtain: new Map(),
    });
    const of = (record: string) => {
      const candidate = candidates.find((c) => c.item.record === record);
      expect(candidate, `${record} is a candidate`).toBeDefined();
      return { candidate: candidate!, projection: projections.get(candidate!.item)! };
    };
    return { save: theSave, aggregate, resolved, candidates, projections, of };
  }

  const bag = (baseName: string, x: number, seed = 1): PositionedItem => ({ ...instance({ baseName, seed }), x, y: 0 });

  it('projects a helm swap against the worn helm, with the outgoing leech and the equip-time requirement check', () => {
    const { of, aggregate } = scene({ bag: [bag(BETTER_HELM, 0, 7)] });
    const { candidate, projection } = of(BETTER_HELM);
    expect(projection.targets.map((t) => t.slot)).toEqual(['Head']);
    const head = projection.targets[0]!;
    expect(head.outgoing?.display).toBe('Old Helm');
    expect(head.skipped).toBeUndefined();
    const fire = head.projection!.resistances.find((r) => r.label === 'Fire')!;
    expect(fire).toMatchObject({ before: 20, after: 35 });
    expect(head.projection!.defense?.sustain).toEqual({ before: 4, after: 0 });
    expect(head.noTrackedGain).toBe(false);
    expect(head.identical).toBe(false);
    // As dressed, the old helm's −12 levels make a level-60 helm wearable at
    // 50; the game checks the incoming item with the outgoing one already off,
    // and that check fails — which is the line §7 prints.
    expect(candidate.check.meets).toBe(true);
    expect(head.postSwap?.meets).toBe(false);
    expect(head.postSwap?.gaps.map((g) => g.attr)).toEqual(['level']);
    expect(aggregate.level).toBe(50);
  });

  it('flags a candidate that improves nothing the projection tracks, and never one that does', () => {
    const { of } = scene({ bag: [bag(WORSE_HELM, 0), bag(BETTER_HELM, 2, 7)] });
    expect(of(WORSE_HELM).projection.noTrackedGain).toBe(true);
    expect(of(BETTER_HELM).projection.noTrackedGain).toBe(false);
  });

  it('projects a ring into both fingers, and an empty slot is not a swap', () => {
    const { of } = scene({ bag: [bag(BETTER_RING, 0)] });
    const { projection } = of(BETTER_RING);
    expect(projection.targets.map((t) => t.slot)).toEqual(['Ring 1', 'Ring 2']);
    const [ring1, ring2] = projection.targets;
    expect(ring1!.outgoing).toBeUndefined();
    expect(ring2!.outgoing?.display).toBe('Plain Ring');
    const pierce = (t: typeof ring1) => t!.projection!.resistances.find((r) => r.label === 'Pierce')!;
    expect(pierce(ring1)).toMatchObject({ before: 10, after: 30 });
    expect(pierce(ring2)).toMatchObject({ before: 10, after: 20 });
    expect(projection.noTrackedGain).toBe(false);
  });

  it('lets a two-hander displace the off hand, and refuses an off-hand while a two-hander is held', () => {
    const shield = instance({ baseName: SHIELD, seed: 5 });
    const held = scene({ bag: [bag(GREATAXE, 0)], off: shield });
    const { projection } = held.of(GREATAXE);
    expect(projection.targets.map((t) => t.slot)).toEqual(['Weapon set 1 main']);
    const main = projection.targets[0]!;
    expect(main.skipped).toBeUndefined();
    expect(main.alsoCleared.map((i) => i.display)).toEqual(['Test Shield']);
    expect(main.projection!.notes.join('\n')).toMatch(/takes both hands: Test Shield leaves the loadout/);

    const twoHanded = scene({ bag: [bag(SHIELD, 0, 5)], main: instance({ baseName: GREATAXE, seed: 9 }) });
    const off = twoHanded.of(SHIELD).projection.targets[0]!;
    expect(off.slot).toBe('Weapon set 1 off');
    expect(off.projection).toBeUndefined();
    expect(off.skipped).toMatch(/a two-hander is held/);
  });

  it('is the same arithmetic as the whole-plan projection', () => {
    const { input } = world();
    const verdicts: AdvisorPlan['verdicts'] = [{ slot: 'Head', itemId: '', verdict: 'EQUIP', targetId: 'cand-helm', reason: '' }];
    const whole = projectPlan(plan({ verdicts }), input)!;
    const single = projectVerdicts(verdicts, input, { before: aggregateCharacter(input.save, input.db, input.difficulty) })!;
    expect(single.projection).toEqual(whole);
    expect(single.after.defense.lifeLeechPercent).toBe(0);
  });
});
