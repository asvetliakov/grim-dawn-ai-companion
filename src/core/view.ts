/**
 * The character, flattened into something a window can paint.
 *
 * Everything here is a plain, structured-clone-safe DTO — no `Map`s, no
 * `GameDb`, no `ResolvedItem`. That is not tidiness for its own sake: this
 * crosses an Electron IPC boundary, and anything that does not survive the
 * structured clone algorithm fails at runtime rather than at compile time.
 *
 * Tooltips are rendered to strings **here**, with the context document's own
 * formatter. The renderer is a dumb painter, which means a tooltip line and the
 * line the advisor read about the same item are produced by one function and
 * cannot disagree — the gendered-locale cleanup, the "name every stat's kind"
 * rule and the granted-skill hop all come along for free.
 */

import { socketableObtain } from './context/builder.js';
import { itemStatBlocks } from './context/filters.js';
import { describeSlots, formatStats, num } from './context/statfmt.js';
import type { DbItem, GameDb, StatValue } from '@grimdawn/core/db/types';
import { sackDims, type GridDims } from '@grimdawn/core/grid';
import type { IconService } from '@grimdawn/core/icons';
import type { CharacterAggregate } from './mechanics/aggregate.js';
import { checkRequirements, type CharacterStanding, type RequirementCheck } from './mechanics/requirements.js';
import { RESIST_COLUMNS } from './mechanics/stats.js';
import { skillLabel } from './mechanics/skills.js';
import type { ItemPosition, ItemSource, ResolvedItem } from '@grimdawn/core/resolve';
import type { CharacterSnapshot } from './session.js';
import { EQUIP_SLOT_NAMES, type Difficulty } from '@grimdawn/core/save/types';

import type {
  UiGrid,
  UiItem,
  UiSnapshot,
  UiSocketable,
  UiSpeedLine,
  UiStatBlock,
  UiStats,
  UiTooltip,
} from '../shared/view.js';

/**
 * The DTO vocabulary lives in `src/shared/view.ts`, which the renderer also
 * compiles — that split is what makes "no Node import may reach the renderer"
 * a compile-time rule rather than a convention. Re-exported so core-side
 * callers have one import.
 */
export type * from '../shared/view.js';

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

export async function buildUiSnapshot(snap: CharacterSnapshot, icons: IconService): Promise<UiSnapshot> {
  const db = snap.input.db;
  const docIds = new Map<ResolvedItem, string>();
  for (const [id, item] of snap.doc.itemsById) docIds.set(item, id);

  const standing = standingOf(snap.aggregate);
  const sizes = await iconSizes(snap.resolved.items, icons);
  // Which skills the character has points in, for the "Modifies: …" lines. The
  // same set the context document builds — without it every skill modifier in
  // every tooltip claimed "(no points invested)", Onslaught at 16 included.
  const invested: ReadonlySet<string> = new Set(
    snap.save.skills.filter((s) => s.level > 0).map((s) => s.record),
  );

  // Where each socketable can be obtained — bought, crafted, on hand, or only
  // inside gear. Derived once from the same input the dossier reads, because a
  // *proposed* component or augment is installed nowhere and its tooltip has to
  // answer "where do I get one" itself.
  const obtain = socketableObtain(snap.input);

  // Socketables are identified by record path, so one id serves the installed
  // copy and the loose one — which is exactly what a plan needs when it says
  // "take the Seal of Might out of that and put it here".
  const socketableIds = new Map<string, string>();
  const socketables: Record<string, UiSocketable> = {};
  for (const [id, part] of snap.doc.socketablesById) {
    socketableIds.set(part.record, id);
    socketables[id] = describeSocketable(part, id, db, invested, obtain.get(part.record));
  }

  const toUi = (item: ResolvedItem): UiItem => {
    const iconPath = item.base?.iconPath || null;
    const size = iconPath ? sizes.get(iconPath) : undefined;
    return {
      docId: docIds.get(item) ?? item.id,
      baseId: item.baseId,
      display: item.display,
      rarity: item.base?.rarity ?? 'Common',
      iconPath,
      cellsW: size?.width ?? 1,
      cellsH: size?.height ?? 1,
      position: item.position,
      source: item.source,
      stackCount: Math.max(1, item.stackCount),
      tooltip: buildTooltip(item, db, standing, socketableIds, invested, obtain),
    };
  };

  // One pass, indexed by where each item sits: the resolved walk is flat, and
  // rebuilding it from the save would be a second place for the two to disagree.
  const byPosition = new Map<string, UiItem>();
  const inSack = new Map<number, UiItem[]>();
  const inStash = new Map<number, UiItem[]>();
  const inTransfer = new Map<number, UiItem[]>();
  const materials: UiItem[] = [];
  for (const item of snap.resolved.items) {
    const ui = toUi(item);
    const p = item.position;
    switch (p.kind) {
      case 'equipment':
        byPosition.set(`e${p.slot}`, ui);
        break;
      case 'weapon':
        byPosition.set(`w${p.set}${p.hand}`, ui);
        break;
      case 'inventory':
        push(inSack, p.sack, ui);
        break;
      case 'stash':
        push(inStash, p.tab, ui);
        break;
      case 'transfer':
        push(inTransfer, p.tab, ui);
        break;
      case 'materials':
        materials.push(ui);
        break;
    }
  }

  const bags: UiGrid[] = snap.save.inventorySacks.map((sack, i) => {
    // The resolve walk visits each sack in order, so the nth resolved item of a
    // sack is the nth saved one — which is how a footprint (an icon fact) meets
    // a coordinate (a save fact) without a positional join.
    const items = inSack.get(i) ?? [];
    const dims = sackDims(sack, i, (_raw, index) => ({
      width: items[index]?.cellsW ?? 1,
      height: items[index]?.cellsH ?? 1,
    }));
    return { label: i === 0 ? 'Bag' : `Bag ${i + 1}`, ...dims, items };
  });

  const personalStash: UiGrid[] = snap.save.personalStash.map((tab, i) => ({
    label: `Tab ${i + 1}`,
    width: tab.width,
    height: tab.height,
    items: inStash.get(i) ?? [],
  }));

  const transferStash: UiGrid[] = (snap.account.stash?.sacks ?? []).map((sack, i) => ({
    label: `Tab ${i + 1}`,
    width: sack.width,
    height: sack.height,
    items: inTransfer.get(i) ?? [],
  }));

  return {
    character: snap.character,
    savePath: snap.savePath,
    gameVersion: db.gameVersion,
    difficulty: snap.difficulty,
    alternateWeaponSetActive: snap.save.alternateWeaponSetActive,
    equipment: EQUIP_SLOT_NAMES.map((_, i) => byPosition.get(`e${i}`) ?? null),
    weaponSets: [
      [byPosition.get('w1main') ?? null, byPosition.get('w1off') ?? null],
      [byPosition.get('w2main') ?? null, byPosition.get('w2off') ?? null],
    ],
    bags,
    personalStash,
    transferStash,
    materials,
    socketables,
    stats: buildStats(snap, db),
    warnings: snap.save.warnings,
  };
}

function push<T>(into: Map<number, T[]>, key: number, value: T): void {
  const list = into.get(key);
  if (list) list.push(value);
  else into.set(key, [value]);
}

/**
 * Every distinct icon's cell footprint, resolved once.
 *
 * A character can reach a couple of hundred items but far fewer distinct
 * textures, and each miss costs an archive read — so the de-duplication is the
 * difference between a snappy refresh and a visible pause.
 */
async function iconSizes(
  items: readonly ResolvedItem[],
  icons: IconService,
): Promise<Map<string, GridDims>> {
  const paths = new Set<string>();
  for (const item of items) if (item.base?.iconPath) paths.add(item.base.iconPath);
  const out = new Map<string, GridDims>();
  await Promise.all(
    [...paths].map(async (path) => {
      const info = await icons.getIconInfo(path);
      // A missing texture is an ordinary answer; the item still occupies a cell.
      out.set(path, { width: info?.cellsW ?? 1, height: info?.cellsH ?? 1 });
    }),
  );
  return out;
}

function standingOf(aggregate: CharacterAggregate): CharacterStanding {
  return {
    level: aggregate.level,
    attributes: {
      physique: aggregate.attributes.physique.total,
      cunning: aggregate.attributes.cunning.total,
      spirit: aggregate.attributes.spirit.total,
    },
    reductions: aggregate.requirementReductions,
  };
}

// ---------------------------------------------------------------------------
// Tooltips
// ---------------------------------------------------------------------------

/** Gear takes a component; relics, jewelry, medals and the like vary. */
const COMPONENT_SLOTS = /^(ArmorProtective_|ArmorJewelry_|WeaponMelee_|WeaponHunting_|WeaponArmor_)/;
const AUGMENT_SLOTS = /^(ArmorProtective_|ArmorJewelry_|WeaponMelee_|WeaponHunting_|WeaponArmor_)/;

const ATTR_KEYS = ['physique', 'cunning', 'spirit'] as const;

/** A `Grants: …` line, which the tooltip shows as its own section. */
const GRANTS = /^Grants: /;

/**
 * The game's template class as a person would say it.
 *
 * The context document prints the raw class (`ArmorProtective_Head`) and must
 * keep doing so — its bytes are the id-stability contract — but a tooltip has
 * no such obligation and "Head Armour" is what the reader wants. Anything not
 * in the table falls back to splitting the class up, which degrades sensibly:
 * `ItemUsableFood` reads "Item Usable Food" rather than a lookup failure.
 */
const SLOT_LABELS: Readonly<Record<string, string>> = {
  ArmorProtective_Head: 'Head Armour',
  ArmorProtective_Chest: 'Chest Armour',
  ArmorProtective_Legs: 'Leg Armour',
  ArmorProtective_Feet: 'Boots',
  ArmorProtective_Hands: 'Gloves',
  ArmorProtective_Shoulders: 'Shoulder Guard',
  ArmorProtective_Waist: 'Belt',
  ArmorJewelry_Amulet: 'Amulet',
  ArmorJewelry_Ring: 'Ring',
  ArmorJewelry_Medal: 'Medal',
  WeaponArmor_Shield: 'Shield',
  WeaponArmor_Offhand: 'Off-hand',
  WeaponMelee_Sword: 'Sword',
  WeaponMelee_Sword2h: 'Two-handed Sword',
  WeaponMelee_Axe: 'Axe',
  WeaponMelee_Axe2h: 'Two-handed Axe',
  WeaponMelee_Mace: 'Mace',
  WeaponMelee_Mace2h: 'Two-handed Mace',
  WeaponMelee_Dagger: 'Dagger',
  WeaponMelee_Scepter: 'Scepter',
  WeaponMelee_Spear2h: 'Spear',
  WeaponHunting_Ranged1h: 'Gun',
  WeaponHunting_Ranged2h: 'Two-handed Gun',
  ItemRelic: 'Relic',
  ItemArtifact: 'Relic',
  ItemArtifactFormula: 'Blueprint',
  ItemEnchantment: 'Component',
  ItemAttributeReset: 'Potion',
  ItemDevotionReset: 'Potion',
  ItemDifficultyUnlock: 'Quest item',
  QuestItem: 'Quest item',
  ItemNote: 'Note',
  OneShot_Scroll: 'Scroll',
  OneShot_PotionHealth: 'Potion',
  OneShot_PotionMana: 'Potion',
  OneShot_Food: 'Consumable',
};

function slotLabel(slot: string | undefined): string {
  if (!slot) return '';
  return SLOT_LABELS[slot] ?? slot.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
}

/**
 * A component or augment on its own, with its dossier id attached.
 *
 * Used both for the one installed in an item and for one the plan merely
 * *proposes* — which has no host to be read off, and is the whole reason the
 * snapshot carries a socketable dictionary at all.
 */
function describeSocketable(
  part: DbItem,
  id: string | undefined,
  db: GameDb,
  invested?: ReadonlySet<string>,
  obtain?: string[],
): UiSocketable {
  const useOn = describeSlots(part.allowedSlots);
  return {
    ...(id ? { id } : {}),
    name: part.name,
    lines: formatStats(part.stats, { db, ...(invested ? { invested } : {}) }),
    iconPath: part.iconPath || null,
    ...(useOn ? { useOn } : {}),
    ...(obtain?.length ? { obtain } : {}),
  };
}

function buildTooltip(
  item: ResolvedItem,
  db: GameDb,
  standing: CharacterStanding,
  socketableIds?: ReadonlyMap<string, string>,
  invested?: ReadonlySet<string>,
  obtain?: ReadonlyMap<string, string[]>,
): UiTooltip {
  const base = item.base;
  const grantedSkills: string[] = [];
  const statLines = (stats: Record<string, StatValue> | undefined): string[] => {
    if (!stats) return [];
    const lines = formatStats(stats, { db, ...(invested ? { invested } : {}) });
    const kept: string[] = [];
    for (const line of lines) {
      if (GRANTS.test(line)) grantedSkills.push(line);
      else kept.push(line);
    }
    return kept;
  };

  const blocks: UiStatBlock[] = [];
  const block = (heading: string | undefined, lines: string[]): void => {
    if (lines.length) blocks.push(heading ? { heading, lines } : { lines });
  };

  block(undefined, statLines(base?.stats));
  if (item.prefix) block(`prefix "${item.prefixName ?? '?'}"`, statLines(item.prefix.stats));
  if (item.suffix) block(`suffix "${item.suffixName ?? '?'}"`, statLines(item.suffix.stats));
  if (item.modifier) block(item.modifierName ?? 'crafting bonus', statLines(item.modifier.stats));
  if (item.completion) block('relic completion bonus', statLines(item.completion.stats));

  /**
   * A socketable keeps its own granted skill instead of surrendering it to the
   * host's block.
   *
   * Lifting it out was wrong twice over. The component's *own* panel — the one
   * that opens on its chip, and the one the plan shows for a component it
   * merely proposes — was built from the stripped lines, so a component whose
   * whole point is the skill it grants (Vicious Spikes, Seal of the Void)
   * described itself as three small stat lines and said nothing about the buff.
   * And in the host's panel the grant appeared under the *item*, which reads as
   * the item's own: it is not, it leaves with the component, and a
   * `SWAP-COMPONENT` is exactly the move that takes it away. Attributed to the
   * part it comes from, it is stated once and in the right place.
   */
  const socketable = (part: DbItem): UiSocketable =>
    describeSocketable(part, socketableIds?.get(part.record), db, invested, obtain?.get(part.record));

  const sockets: string[] = [];
  const slot = base?.slot ?? '';
  if (!item.component && COMPONENT_SLOTS.test(slot)) sockets.push('Component socket: empty');
  if (!item.augment && AUGMENT_SLOTS.test(slot)) sockets.push('Augment: none');
  if (item.augment) sockets.push('Soulbound while the augment is applied');

  const check: RequirementCheck | undefined = base ? checkRequirements(item, standing) : undefined;

  const tooltip: UiTooltip = {
    title: item.display,
    rarity: base?.rarity ?? 'Common',
    affixes: [item.prefixName, item.suffixName, item.modifierName].filter((n): n is string => Boolean(n)),
    blocks,
    sockets,
    grantedSkills,
    unresolved: item.unresolved,
  };

  const typeLine = [
    base?.rarity,
    slotLabel(base?.slot),
    base?.setName ? `set: ${base.setName}` : '',
    // A handful of things the game classes as quest items — Ancient Heart,
    // Dynamite — are also crafting reagents, and the store is where they live.
    // Saying both is the only accurate answer; picking one is a guess.
    item.source === 'materials' ? 'in the crafting store' : '',
    item.stackCount > 1 ? `×${item.stackCount}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  if (typeLine) tooltip.typeLine = typeLine;
  if (item.component) tooltip.component = socketable(item.component);
  if (item.augment) tooltip.augment = socketable(item.augment);
  // A loose component or augment states where it can go, exactly as its chip
  // does once installed. This is the panel a reader opens over a bag or the
  // materials list, where "use on what?" is the whole question.
  if (base?.allowedSlots?.length) tooltip.useOn = describeSlots(base.allowedSlots);

  const req = item.requirements;
  if (req) {
    const demands = [`level ${req.level}`, ...ATTR_KEYS.filter((k) => req[k] !== undefined).map((k) => `${num(req[k]!)} ${k}`)];
    const lines = [...demands];
    for (const gap of check?.gaps ?? []) {
      lines.push(
        // A gap, and only a gap. The context document's copy of this line adds
        // "(HOLD until then)" because it is addressing the *advisor*, in the
        // middle of a candidate ranking, and telling it not to reject an item
        // over a deficit levelling will close. Here it addressed the player,
        // and said HOLD about every over-levelled item in the stash before any
        // advice had been asked for — which is the same category error the plan
        // schema now guards against. Whether to keep this item is a
        // recommendation; being unable to wear it yet is a fact.
        gap.attr === 'level'
          ? `needs level ${gap.need} — ${gap.deficit} more`
          : `short ${gap.deficit} ${gap.attr} (have ${gap.have}, needs ${gap.need} after reductions)`,
      );
    }
    tooltip.requirements = lines;
    if (check) tooltip.meetsRequirements = check.meets;
  }

  return tooltip;
}

// ---------------------------------------------------------------------------
// Stats panel
// ---------------------------------------------------------------------------

function buildStats(snap: CharacterSnapshot, db: GameDb): UiStats {
  const agg = snap.aggregate;
  const save = snap.save;
  const r = agg.resistances;
  const d = agg.defense;
  const a = agg.attributes;

  const className = db.localize(save.classRecord);
  const masteries = save.skills
    .map((s) => db.getSkill(s.record))
    .filter((s) => s?.class === 'Skill_Mastery')
    .map((s) => skillLabel(s!, db));

  const wielding: UiStats['wielding'] = {
    mode: agg.wielding.mode,
    enablers: agg.wielding.enablers.map((e) => (e.source === 'skill' ? e.name : `${e.name} (${e.source})`)),
  };
  if (agg.wielding.mainHand) wielding.mainHand = agg.wielding.mainHand;
  if (agg.wielding.offHand) wielding.offHand = agg.wielding.offHand;

  const speedLine = (line: CharacterAggregate['speed']['attack'], unit: string): UiSpeedLine => ({
    label: line.label,
    percent: line.percent,
    percentWithMaintainable: line.percentWithMaintainable,
    cap: line.cap,
    rate: line.rate,
    rateWithMaintainable: line.rateWithMaintainable,
    headroom: line.headroom,
    wasted: Math.max(0, line.rawPercentWithMaintainable - line.cap),
    unit,
  });

  const stats: UiStats = {
    level: agg.level,
    className: className === save.classRecord ? masteries.join('/') : className,
    masteries,
    difficulty: agg.difficulty,
    hardcore: save.hardcore,
    iron: save.iron,
    wielding,
    attributes: ATTR_KEYS.map((key) => ({
      key,
      label: key === 'physique' ? 'Physique' : key === 'cunning' ? 'Cunning' : 'Spirit',
      base: a[key].base,
      flat: a[key].flat,
      percent: a[key].percent,
      total: a[key].total,
    })),
    health: save.attributes.health,
    energy: save.attributes.energy,
    healthBonus: { flat: d.health, percent: d.healthPercent },
    offensiveAbility: a.offensiveAbility,
    defensiveAbility: a.defensiveAbility,
    unspent: {
      attribute: save.attributes.attributePoints,
      skill: save.attributes.skillPoints,
      devotion: save.attributes.devotionPoints,
    },
    resistances: RESIST_COLUMNS.map((c) => ({
      key: c.key,
      label: c.label,
      permanent: r.permanent[c.key] ?? 0,
      withMaintainable: r.withMaintainable[c.key] ?? 0,
      penalty: r.penalty[c.key] ?? 0,
      effective: r.effective[c.key] ?? 0,
      cap: r.caps[c.key] ?? 0,
    })),
    secondaryResistances: r.secondary,
    armor: d.armorSlots.map((s) => ({
      slot: s.slot,
      hitChance: s.hitChance,
      piece: s.piece,
      effective: s.effective,
      weakest: s === d.weakestSlot,
    })),
    armorAverage: d.armorAverage,
    armorClasses: d.armorClasses,
    armorBonus: { flat: d.bonusArmor, percent: d.armorPercent },
    absorption: d.absorption,
    absorptionBase: d.absorptionBase,
    sustain: d.lifeLeechPercent,
    speeds: [
      speedLine(agg.speed.attack, 'attacks/s'),
      speedLine(agg.speed.cast, 'casts/s'),
      speedLine(agg.speed.movement, '× base'),
    ],
    damage: {
      entries: agg.damage.ranked.map((e) => ({
        key: e.key,
        label: e.label,
        percent: e.percent,
        flat: e.flat,
        overTime: e.overTime,
      })),
      totalPercent: agg.damage.totalDamagePercent,
      ...(agg.damage.weaponAttack.mainAttack ? { mainAttack: agg.damage.weaponAttack.mainAttack } : {}),
      composition: agg.damage.weaponAttack.composition.map((c) => ({
        label: c.label,
        share: c.share,
        overTime: c.overTime,
      })),
    },
    exclusions: agg.exclusions,
  };
  // Block numbers mean nothing without a shield, so they are absent rather than
  // zero — the difference between "you block nothing" and "you cannot block".
  if (d.hasShield) stats.block = { chance: d.blockChance, amount: d.blockAmount };
  return stats;
}
