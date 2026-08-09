/**
 * Made-up data for the stories.
 *
 * Every name, stat line and record here is invented. That is not laziness: the
 * real snapshot is derived from Crate's game files and this repository ships
 * code, not data, so a fixture cut from a live save could not be committed. It
 * also makes the stories deterministic, which a real save — which changes every
 * time the game autosaves — never would be.
 *
 * The shapes are the real ones. If `UiSnapshot` or `AdviseEnvelope` change, this
 * file stops compiling, which is exactly the alarm you want.
 */

import type { AdviseEnvelope, UiGrid, UiItem, UiSnapshot, UiSocketable, UiStats } from '../../shared/ipc.js';
import type { ItemPosition } from '../../shared/ipc.js';
import { currentWorn } from './components/LoadoutPanel.js';

let nextId = 0;
const id = (): string => `f${(nextId++).toString(36).padStart(3, '0')}`;

interface ItemSpec {
  name: string;
  rarity: string;
  type: string;
  cells?: [number, number];
  stats?: string[];
  component?: { name: string; lines: string[] };
  augment?: { name: string; lines: string[] };
  /** Socketable art is invented per name, like the item art. */
  requirements?: string[];
  meets?: boolean;
  grants?: string[];
  affixes?: string[];
  stack?: number;
  /** Where the item may be applied, when the item is itself a socketable. */
  useOn?: string;
}

/**
 * A socketable with a texture path of its own, shaped like the real one.
 *
 * The id is derived from the name rather than random, because a socketable's
 * real identity is its record path — one id serves the copy installed in an
 * item, the loose one in the store, and the one a plan proposes. Deriving it
 * the same way here is what lets the fixture's socket verdicts join.
 */
function socketable(part: { name: string; lines: string[]; useOn?: string }): UiSocketable {
  const slug = part.name.toLowerCase().replace(/[^a-z]+/g, '-');
  return {
    id: `s-${slug}`,
    name: part.name,
    lines: part.lines,
    iconPath: `items/fixture/socket-${slug}.tex`,
    ...(part.useOn ? { useOn: part.useOn } : {}),
  };
}

/**
 * A component whose point is the skill it grants, not its one stat line.
 *
 * Written once and used for both the installed copy and the dictionary entry,
 * the way the real snapshot builds both from one record. The grant belongs to
 * the *component*: it arrives with it and leaves with it, so the host item's
 * granted-skill block must not claim it.
 */
const SEAL_OF_MIGHT = {
  name: 'Seal of Might',
  lines: [
    '+40% Physical Damage',
    'Grants: Might of Empyrion (toggle — stays on until switched off) — +60 Physical Damage; +12% Physical Damage; 15% Energy Reserved',
  ],
};

/**
 * Socketables the dossier offered, including ones installed nowhere.
 *
 * The last two exist only here: a plan routinely proposes a component the
 * character owns loose or can buy, and the whole reason the snapshot carries
 * this dictionary is that such a component has no host to be read off.
 */
const SOCKETABLES: UiSocketable[] = [
  socketable({ name: 'Runestone', lines: ['+12% Fire, Cold and Lightning Resistance'] }),
  socketable({ name: 'Sanctified Bone', lines: ['+18% Vitality Resistance', '+12% Chaos Resistance'] }),
  socketable(SEAL_OF_MIGHT),
  socketable({
    name: 'Mark of Mogdrogen',
    lines: ['+25% Bleeding Resistance', '+3% Health Regenerated per second'],
    useOn: 'boots, leg armour, shoulder guards',
  }),
  socketable({
    name: 'Kymon’s Vigil',
    lines: ['+18% Fire Damage', '+40 Offensive Ability', '+12% Chaos Resistance'],
    useOn: 'rings, amulets, medals',
  }),
  socketable({
    name: 'Bloodied Crystal',
    lines: ['+30% Bleeding Damage', '+8% Attack Speed'],
    useOn: 'one-handed melee weapons',
  }),
];

function item(spec: ItemSpec, position: ItemPosition): UiItem {
  const [cellsW, cellsH] = spec.cells ?? [2, 2];
  const docId = id();
  const sockets: string[] = [];
  if (!spec.component) sockets.push('Component socket: empty');
  if (!spec.augment) sockets.push('Augment: none');
  else sockets.push('Soulbound while the augment is applied');

  const ui: UiItem = {
    docId,
    display: spec.name,
    rarity: spec.rarity,
    // A texture path shaped like the real thing. Nothing resolves it in a
    // story; the icon resolver the stories inject draws a stand-in.
    iconPath: `items/fixture/${docId}.tex`,
    cellsW,
    cellsH,
    position,
    source:
      position.kind === 'equipment' || position.kind === 'weapon'
        ? 'equipped'
        : position.kind === 'inventory'
          ? 'inventory'
          : position.kind === 'stash'
            ? 'stash'
            : position.kind === 'transfer'
              ? 'transfer'
              : 'materials',
    stackCount: spec.stack ?? 1,
    tooltip: {
      title: spec.name,
      rarity: spec.rarity,
      typeLine: spec.type,
      affixes: spec.affixes ?? [],
      blocks: spec.stats?.length ? [{ lines: spec.stats }] : [],
      sockets,
      grantedSkills: spec.grants ?? [],
      unresolved: [],
      ...(spec.component ? { component: socketable(spec.component) } : {}),
      ...(spec.augment ? { augment: socketable(spec.augment) } : {}),
      ...(spec.requirements ? { requirements: spec.requirements, meetsRequirements: spec.meets ?? true } : {}),
      ...(spec.useOn ? { useOn: spec.useOn } : {}),
    },
  };
  return ui;
}

const EQUIPPED: (ItemSpec | null)[] = [
  {
    name: 'Ashfallen Visor',
    rarity: 'Epic',
    type: 'Epic · Head Armour',
    stats: ['+22% Fire Resistance', '+18% Lightning Resistance', '616 Armor', '+3 to Searing Might'],
    component: { name: 'Runestone', lines: ['+12% Fire, Cold and Lightning Resistance'] },
    requirements: ['level 70', '512 physique'],
  },
  {
    name: 'Torc of the Drowned',
    rarity: 'Rare',
    type: 'Rare · Amulet',
    cells: [1, 1],
    stats: ['+15% Aether Resistance', '+40 Offensive Ability'],
    requirements: ['level 65', '244 spirit'],
  },
  {
    name: 'Stalkers Wrap of the Blind Watch',
    rarity: 'Epic',
    type: 'Epic · Chest Armour · set: The Unseeing Eye',
    cells: [2, 3],
    affixes: ['of the Blind Watch'],
    stats: ['+36% Pierce Damage', '+26% Fire, Cold and Lightning Resistance', '991 Armor'],
    component: { name: 'Sanctified Bone', lines: ['+18% Vitality Resistance', '+12% Chaos Resistance'] },
    requirements: ['level 72', '499 physique'],
  },
  {
    name: 'Bloodrite Legguards',
    rarity: 'Epic',
    type: 'Epic · Leg Armour',
    cells: [2, 3],
    stats: ['+38% Aether Resistance', '+4% Physical Resistance', '450 Armor', '+550 Health'],
    component: { name: 'Ancient Armor Plate', lines: ['+8% Armor Absorption', '+35 Armor to every body part'] },
    requirements: ['level 50', '359 physique'],
  },
  {
    name: 'Bloodhound Greaves',
    rarity: 'Epic',
    type: 'Epic · Boots',
    stats: ['+25% Vitality Resistance', '+8% Movement Speed', '898 Armor'],
    requirements: ['level 58', '402 physique'],
  },
  {
    name: 'Silktouch Handwraps',
    rarity: 'Magical',
    type: 'Magical · Gloves',
    stats: ['+12% Pierce Resistance', '+12% Aether Resistance', '326 Armor'],
    component: { name: 'Unholy Inscription', lines: ['+10% Vitality Resistance', '+15% Bleeding Resistance'] },
    requirements: ['level 48', '298 physique'],
  },
  {
    name: 'Shrewd Cronley’s Signet of Untamed Fangs',
    rarity: 'Rare',
    type: 'Rare · Ring',
    cells: [1, 1],
    affixes: ['Shrewd', 'of Untamed Fangs'],
    stats: ['+26% Pierce Resistance', '+8% Bleeding Damage'],
    component: { name: 'Soul Shard', lines: ['+20% Vitality Resistance'] },
    augment: { name: 'Coven Warding Salve', lines: ['+15% Aether Resistance', '+15% Chaos Resistance'] },
    requirements: ['level 62', '210 cunning'],
  },
  {
    name: 'Amarastan Sigil',
    rarity: 'Epic',
    type: 'Epic · Ring',
    cells: [1, 1],
    stats: ['+20% Bleeding Resistance', '+35 Defensive Ability'],
    requirements: ['level 66', '228 cunning'],
  },
  {
    name: 'Dreadweave Girdle',
    rarity: 'Epic',
    type: 'Epic · Belt',
    cells: [2, 1],
    stats: ['+30% Aether Resistance', '+16% Vitality Resistance'],
    requirements: ['level 60', '388 physique'],
  },
  {
    name: 'Impervious Chosen Epaulets of Prowess',
    rarity: 'Rare',
    type: 'Rare · Shoulder Guard',
    affixes: ['Impervious', 'of Prowess'],
    stats: ['+48% Pierce Resistance', '+60% Acid Resistance', '842 Armor'],
    requirements: ['level 74', '540 physique'],
  },
  {
    name: 'Mark of the Long Hunt',
    rarity: 'Legendary',
    type: 'Legendary · Medal',
    cells: [1, 1],
    stats: ['+30% Bleeding Damage', '+18% Attack Speed'],
    grants: ['Grants: Blood Rush (activated — you have to cast it) — 40 Energy per cast'],
    requirements: ['level 80', '0 physique'],
  },
  {
    name: 'Shard of Beronath',
    rarity: 'Legendary',
    type: 'Legendary · Relic',
    stats: ['+1 to all Nightblade skills', '+90 Offensive Ability'],
    requirements: ['level 75'],
  },
];

const WEAPONS: ItemSpec[] = [
  {
    name: 'Servitor’s Slicer',
    rarity: 'Legendary',
    type: 'Legendary · Sword',
    cells: [2, 4],
    stats: ['+146–248 Physical Damage', '+120% Pierce Damage', '+65% Internal Trauma Damage', '1.21 Attacks per Second'],
    component: SEAL_OF_MIGHT,
    requirements: ['level 80', '620 cunning'],
  },
  {
    name: 'Bloodborn Sabre',
    rarity: 'Epic',
    type: 'Epic · Sword',
    cells: [2, 4],
    stats: ['+98–181 Physical Damage', '+85% Bleeding Damage', '+40% Burn Damage', '+22% Fire Damage', '1.21 Attacks per Second'],
    requirements: ['level 72', '548 cunning'],
  },
];

const LOOSE: ItemSpec[] = [
  {
    name: 'Mythical Ashfallen Visor',
    rarity: 'Legendary',
    type: 'Legendary · Head Armour',
    stats: ['+30% Fire Resistance', '+24% Lightning Resistance', '812 Armor', '+4 to Searing Might'],
    requirements: ['level 84', '640 physique'],
    meets: false,
  },
  {
    name: 'Voidsteel Gauntlets',
    rarity: 'Legendary',
    type: 'Legendary · Gloves',
    stats: ['+22% Pierce Resistance', '+18% Chaos Resistance', '540 Armor'],
    // A proposed item arrives with whatever is already in it, and those two
    // socketables are usually half the reason to propose it — so the story has
    // to show a *new* item's component and augment, not only an equipped one's.
    component: { name: 'Sanctified Bone', lines: ['+18% Vitality Resistance', '+12% Chaos Resistance'] },
    augment: { name: 'Coven Warding Salve', lines: ['+15% Aether Resistance', '+15% Chaos Resistance'] },
    requirements: ['level 78', '520 physique'],
  },
  {
    name: 'Preposterously Ostentatious Harbinger’s Girdle of the Everlasting Midnight Vigil',
    rarity: 'Epic',
    type: 'Epic · Belt',
    cells: [2, 1],
    stats: ['+24% Aether Resistance', '+400 Health'],
    requirements: ['level 70', '440 physique'],
  },
  { name: 'Aetherial Missive', rarity: 'Quest', type: 'Quest · Quest item', cells: [1, 1] },
  { name: 'Blood of Ch’thon', rarity: 'Common', type: 'Common · Component', cells: [1, 1], stack: 4 },
  // A spare weapon carrying a component worth more than the weapon is: the
  // Inventor recovers *either* the item or the component, never both, which is
  // the one move in the game that destroys something on purpose.
  {
    name: 'Chillheart Blade',
    rarity: 'Epic',
    type: 'Epic · Sword',
    cells: [2, 4],
    stats: ['+70–140 Cold Damage', '1.15 Attacks per Second'],
    component: { name: 'Bloodied Crystal', lines: ['+30% Bleeding Damage', '+8% Attack Speed'] },
    requirements: ['level 65', '480 cunning'],
  },
];

const MATERIALS: ItemSpec[] = [
  {
    name: 'Manticore Eye',
    rarity: 'Common',
    type: 'Common · Component · in the crafting store',
    cells: [1, 1],
    stack: 3,
    stats: ['+18% Acid Resistance', '+24 Offensive Ability'],
    // A loose component states where it can go, exactly as its chip does once
    // installed — "use on what?" is the whole question about a loose one.
    useOn: 'any armor, shields',
  },
  {
    name: 'Sanctified Bone',
    rarity: 'Common',
    type: 'Common · Component · in the crafting store',
    cells: [1, 1],
    stack: 2,
    stats: ['+18% Vitality Resistance', '+12% Chaos Resistance', '+8% Damage to Undead'],
  },
  // The game classes these as quest items and they are *also* reagents. Saying
  // both is the only accurate answer; picking one would be a guess.
  {
    name: 'Ancient Heart',
    rarity: 'Quest',
    type: 'Quest · Quest item · in the crafting store',
    cells: [1, 1],
    stack: 12,
  },
  {
    name: 'Dynamite',
    rarity: 'Quest',
    type: 'Quest · Quest item · in the crafting store',
    cells: [1, 1],
    stack: 5,
  },
  {
    name: 'Aether Crystal',
    rarity: 'Common',
    type: 'Common · Crafting material · in the crafting store',
    cells: [1, 1],
    stack: 42,
  },
  {
    name: 'Royal Jelly',
    rarity: 'Common',
    type: 'Common · Crafting material · in the crafting store',
    cells: [1, 1],
    stack: 6,
  },
];

function grid(label: string, width: number, height: number, items: UiItem[]): UiGrid {
  return { label, width, height, items };
}

/** Lay specs out left to right, wrapping — enough to look like a real bag. */
function pack(specs: ItemSpec[], width: number, make: (x: number, y: number) => ItemPosition): UiItem[] {
  const out: UiItem[] = [];
  let x = 0;
  let y = 0;
  for (const spec of specs) {
    const [w, h] = spec.cells ?? [2, 2];
    if (x + w > width) {
      x = 0;
      y += 4;
    }
    out.push(item(spec, make(x, y)));
    x += w;
  }
  return out;
}

const stats: UiStats = {
  level: 82,
  className: 'Reaver',
  masteries: ['Necromancer', 'Nightblade'],
  difficulty: 'Ultimate',
  hardcore: false,
  iron: 1_315_676,
  wielding: {
    mode: 'dual-wield melee',
    mainHand: 'Servitor’s Slicer',
    offHand: 'Bloodborn Sabre',
    enablers: ['Dual Blades', 'Implements of War'],
  },
  attributes: [
    { key: 'physique', label: 'Physique', base: 218, flat: 375, percent: 0, total: 593 },
    { key: 'cunning', label: 'Cunning', base: 506, flat: 687, percent: 16, total: 1384 },
    { key: 'spirit', label: 'Spirit', base: 90, flat: 195, percent: 5, total: 299 },
  ],
  health: 1186,
  energy: 330,
  healthBonus: { flat: 4320, percent: 18 },
  offensiveAbility: { flat: 590, percent: 9 },
  defensiveAbility: { flat: 207, percent: 0 },
  unspent: { attribute: 2, skill: 0, devotion: 1 },
  resistances: [
    { key: 'physical', label: 'Physical', permanent: 10, withMaintainable: 10, penalty: 0, effective: 10, cap: 80 },
    { key: 'pierce', label: 'Pierce', permanent: 137, withMaintainable: 137, penalty: -50, effective: 87, cap: 80 },
    { key: 'fire', label: 'Fire', permanent: 94, withMaintainable: 124, penalty: -50, effective: 74, cap: 80 },
    { key: 'cold', label: 'Cold', permanent: 94, withMaintainable: 124, penalty: -50, effective: 74, cap: 80 },
    { key: 'lightning', label: 'Lightning', permanent: 94, withMaintainable: 124, penalty: -50, effective: 74, cap: 80 },
    { key: 'acid', label: 'Acid', permanent: 150, withMaintainable: 150, penalty: -50, effective: 100, cap: 80 },
    { key: 'vitality', label: 'Vitality', permanent: 119, withMaintainable: 119, penalty: -25, effective: 94, cap: 80 },
    { key: 'aether', label: 'Aether', permanent: 179, withMaintainable: 179, penalty: -25, effective: 154, cap: 80 },
    { key: 'chaos', label: 'Chaos', permanent: 89, withMaintainable: 89, penalty: -25, effective: 64, cap: 80 },
    { key: 'bleeding', label: 'Bleeding', permanent: 63, withMaintainable: 63, penalty: -25, effective: 38, cap: 80 },
  ],
  secondaryResistances: [
    { label: 'Slow', value: 70 },
    { label: 'Freeze', value: 52 },
    { label: 'Stun', value: 25 },
  ],
  armor: [
    { slot: 'Head', hitChance: 12, piece: 616, effective: 1285, weakest: false },
    { slot: 'Shoulders', hitChance: 12, piece: 842, effective: 1549, weakest: false },
    { slot: 'Chest', hitChance: 24, piece: 991, effective: 1723, weakest: false },
    { slot: 'Hands', hitChance: 16, piece: 326, effective: 945, weakest: true },
    { slot: 'Legs', hitChance: 20, piece: 450, effective: 1090, weakest: false },
    { slot: 'Feet', hitChance: 16, piece: 898, effective: 1615, weakest: false },
  ],
  armorAverage: 1381,
  armorClasses: ['Light'],
  armorBonus: { flat: 482, percent: 17 },
  absorption: 89.6,
  absorptionBase: 70,
  speeds: [
    {
      label: 'Attack',
      percent: 177,
      percentWithMaintainable: 182,
      cap: 200,
      rate: 2.21,
      rateWithMaintainable: 2.27,
      headroom: 19,
      wasted: 0,
      unit: 'attacks/s',
    },
    {
      label: 'Casting',
      percent: 126,
      percentWithMaintainable: 131,
      cap: 200,
      rate: 1.57,
      rateWithMaintainable: 1.64,
      headroom: 69,
      wasted: 0,
      unit: 'casts/s',
    },
    {
      label: 'Movement',
      percent: 138,
      percentWithMaintainable: 138,
      cap: 138,
      rate: 1.28,
      rateWithMaintainable: 1.28,
      headroom: 0,
      wasted: 15,
      unit: '× base',
    },
  ],
  exclusions: [
    'item-granted skills and procs are named, not summed',
    'pet bonuses and pet skill trees are out of scope',
    'the engine’s own OA/DA floor from level and attributes is not modelled',
  ],
};

/** A whole character, invented from nothing. */
export function fixtureSnapshot(): UiSnapshot {
  nextId = 0;
  const equipment = EQUIPPED.map((spec, slot) => (spec ? item(spec, { kind: 'equipment', slot }) : null));
  const weaponSet1: (UiItem | null)[] = [
    item(WEAPONS[0]!, { kind: 'weapon', set: 1, hand: 'main' }),
    item(WEAPONS[1]!, { kind: 'weapon', set: 1, hand: 'off' }),
  ];
  const bagItems = pack(LOOSE, 12, (x, y) => ({ kind: 'inventory', sack: 0, x, y }));
  const stashItems = pack([LOOSE[1]!, LOOSE[2]!], 19, (x, y) => ({ kind: 'stash', tab: 0, x, y }));
  const transferItems = pack([LOOSE[0]!, LOOSE[3]!], 19, (x, y) => ({ kind: 'transfer', tab: 0, x, y }));

  return {
    character: '_Fixture',
    savePath: '/fixture/main/_Fixture/player.gdc',
    gameVersion: 'Version 1.3.0.6',
    difficulty: 'Ultimate',
    alternateWeaponSetActive: false,
    equipment,
    weaponSets: [weaponSet1, [null, null]],
    bags: [grid('Bag', 12, 8, bagItems), grid('Bag 2', 8, 8, [])],
    personalStash: [grid('Tab 1', 19, 10, stashItems)],
    transferStash: [grid('Tab 1', 19, 10, transferItems), grid('Tab 2', 19, 10, [])],
    materials: MATERIALS.map((spec) => item(spec, { kind: 'materials' })),
    socketables: Object.fromEntries(SOCKETABLES.map((part) => [part.id!, part])),
    stats,
    warnings: [],
  };
}

/**
 * An advice run over that character. The ids are read back out of the snapshot
 * so the loadout's join, the container highlight and the reveal all exercise
 * the same code path they will with a real envelope.
 */
/**
 * The `worn` / `wornSockets` pair an envelope carries, from a live snapshot.
 *
 * The two halves are separate fields because an item's document id includes its
 * attachments, so "the component changed" and "the item changed" are otherwise
 * indistinguishable — see the schema note on `wornSockets`.
 */
function storedLoadout(snapshot: UiSnapshot): Pick<AdviseEnvelope, 'worn' | 'wornSockets'> {
  const worn: Record<string, string> = {};
  const wornSockets: Record<string, { component?: string; augment?: string }> = {};
  for (const [slot, item] of Object.entries(currentWorn(snapshot))) {
    worn[slot] = item.itemId;
    const sockets = {
      ...(item.componentId ? { component: item.componentId } : {}),
      ...(item.augmentId ? { augment: item.augmentId } : {}),
    };
    if (sockets.component ?? sockets.augment) wornSockets[slot] = sockets;
  }
  return { worn, wornSockets };
}

export function fixtureAdvice(snapshot: UiSnapshot): AdviseEnvelope {
  const bag = snapshot.bags[0]?.items ?? [];
  const head = snapshot.equipment[0]!;
  const feet = snapshot.equipment[4]!;
  const hands = snapshot.equipment[5]!;
  const ring1 = snapshot.equipment[6]!;
  const belt = snapshot.equipment[8]!;
  const mainHand = snapshot.weaponSets[0][0]!;
  const mythicalVisor = bag[0]!;
  const gauntlets = bag[1]!;
  const girdle = bag[2]!;
  const spareBlade = bag[5]!;
  // The second copy of a pair, so the fourth kind of mark has something to be
  // about: a sell is not an extraction, and the two must not read alike.
  const duplicateGauntlets = snapshot.personalStash[0]?.items[0]!;

  return {
    character: snapshot.character,
    generatedAt: '2026-08-09T09:15:00.000Z',
    gameVersion: snapshot.gameVersion,
    provider: 'claude-cli',
    model: 'opus',
    effort: 'high',
    question: 'I am committing to bleeding — do not protect the physical damage.',
    calls: 2,
    usage: { inputTokens: 36_412, outputTokens: 40_180, costUsd: 4.16 },
    durationMs: 845_000,
    warnings: [],
    firstWarnings: [
      { kind: 'ambiguous-stat', message: 'Head: "+22 FCL" does not say whether it is damage or resistance' },
    ],
    revised: true,
    revisionRejected: false,
    answer: FIXTURE_ANSWER,
    plan: {
      summary:
        'A dual-wield pierce/bleed Reaver at the Ultimate resistance wall. Bleeding is 42 points under cap and Physical is barely modelled at all; both are fixable from what is already in the bags, at the cost of a little armour on the hands.',
      verdicts: [
        {
          slot: 'Head',
          itemId: head.docId,
          itemName: head.display,
          verdict: 'KEEP',
          reason: 'The Mythical version is two levels away and strictly better.',
        },
        // The two swaps carry their own gains, costs and argument. `verdictRows`
        // is *derived* from these fields, so a fixture that filled only the rows
        // would be describing an envelope no run can produce — and the item
        // panels, which read the plan, would have nothing to say.
        {
          slot: 'Hands',
          itemId: hands.docId,
          itemName: hands.display,
          verdict: 'EQUIP',
          target: gauntlets.docId,
          targetId: gauntlets.docId,
          targetName: gauntlets.display,
          // An EQUIP that also says what to put *in* the new item. One verdict per
          // slot has one name, and an item holds a component and an augment in
          // independent sockets — so the second instruction lives in `fits`, and
          // without it a plan that argued for the component in prose could not
          // show it. The first live run hit exactly this on the Neck slot.
          fits: [
            { kind: 'component', id: 's-mark-of-mogdrogen', name: 'Mark of Mogdrogen' },
            { kind: 'augment', id: 's-kymon-s-vigil', name: 'Kymon’s Vigil' },
          ],
          gains: ['+10% Pierce Resistance', '+18% Chaos Resistance', '+214 Armor'],
          costs: ['−10% Vitality Resistance', '−15% Bleeding Resistance'],
          reason: 'Chaos goes over cap; the component you lose is replaceable from the store.',
        },
        {
          slot: 'Belt',
          itemId: belt.docId,
          itemName: belt.display,
          verdict: 'EQUIP',
          target: girdle.docId,
          targetId: girdle.docId,
          targetName: girdle.display,
          gains: ['+400 Health'],
          costs: ['−6% Aether Resistance', '−16% Vitality Resistance'],
          reason: 'Aether is 74 points over cap, so it is free to spend.',
        },
        // The three shapes a socket move comes in: an empty socket filled (free),
        // an augment replaced (the old one is simply gone), and a component
        // taken out of another item, which destroys that item.
        {
          slot: 'Feet',
          itemId: feet.docId,
          itemName: feet.display,
          verdict: 'ADD-COMPONENT',
          target: 'Mark of Mogdrogen',
          targetId: 's-mark-of-mogdrogen',
          targetName: 'Mark of Mogdrogen',
          gains: ['+25% Bleeding Resistance'],
          reason: 'The socket is empty, so this costs nothing but the component.',
        },
        {
          slot: 'Ring 1',
          itemId: ring1.docId,
          itemName: ring1.display,
          verdict: 'RE-AUGMENT',
          target: 'Kymon’s Vigil',
          targetId: 's-kymon-s-vigil',
          targetName: 'Kymon’s Vigil',
          gains: ['+40 Offensive Ability', '+12% Chaos Resistance'],
          costs: ['−15% Aether Resistance'],
          reason: 'Aether is 74 points over cap; Offensive Ability is not.',
        },
        {
          slot: 'Weapon set 1 main',
          itemId: mainHand.docId,
          itemName: mainHand.display,
          verdict: 'SWAP-COMPONENT',
          target: 'Bloodied Crystal',
          targetId: 's-bloodied-crystal',
          targetName: 'Bloodied Crystal',
          componentFrom: spareBlade.docId,
          gains: ['+30% Bleeding Damage', '+8% Attack Speed'],
          costs: ['−40% Physical Damage'],
          reason: 'Bleeding is where this build’s damage actually lands.',
        },
      ],
      hold: [
        {
          itemId: mythicalVisor.docId,
          itemName: mythicalVisor.display,
          // A hold names what it is for. Being unequippable is a fact about the
          // item; being the thing you will put on when it stops being one is
          // the recommendation.
          slot: 'Head',
          beats: head.docId,
          gains: ['+8% Fire Resistance', '+6% Lightning Resistance', '+196 Armor'],
          reason: 'strictly better than the visor you are wearing',
          until: 'level 84',
          needs: { levels: 2 },
        },
      ],
      sell: [duplicateGauntlets.docId],
      keyMoves: [
        {
          title: 'Close the Bleeding gap',
          slots: ['Hands'],
          itemIds: [gauntlets.docId],
          detail:
            'Voidsteel Gauntlets bring +22% Pierce Resistance and +18% Chaos Resistance; Chaos moves 64 → 82, over cap for the first time.',
        },
        {
          title: 'Two levels buy the head slot',
          slots: ['Head'],
          itemIds: [mythicalVisor.docId],
          detail: 'The Mythical visor is a flat upgrade at level 84 — nothing else you own competes.',
        },
      ],
      projectedResistances: {
        Physical: 10,
        Pierce: 95,
        Fire: 74,
        Cold: 74,
        Lightning: 74,
        Acid: 100,
        Vitality: 94,
        Aether: 148,
        Chaos: 82,
        Bleeding: 38,
      },
      projected: {
        attackSpeedPercent: 177,
        castSpeedPercent: 126,
        movementSpeedPercent: 138,
        notDerivable: ['Offensive Ability, because the engine’s level floor is not modelled'],
        notes: [],
      },
      // The ladder. Two of the four entries on the first live run were "skip
      // this", which is the recommendation the section exists to carry: §12 of
      // the dossier costs every threshold, and a costing with no verdict on it
      // is not advice.
      nextLevels: [
        {
          threshold: 'level 84',
          unlocks: [mythicalVisor.docId],
          recommendation:
            'Worth it — the Mythical visor is a flat upgrade and the two attribute points those levels grant are not needed by anything else. Put both into Cunning.',
        },
        {
          threshold: '4 attribute points into Spirit (299 → 331)',
          unlocks: [],
          recommendation: 'Skip — nothing this character can reach at 331 Spirit beats what is already worn.',
        },
      ],
    },
    // The loadout the run was written against, sockets and all. Equal to the live
    // one here, which is the ordinary case — a stored run and the save it
    // describes. The drifted and already-applied cases get their own stories.
    ...storedLoadout(snapshot),
    verdictRows: [
      {
        slot: 'Head',
        current: `${head.display} #${head.docId}`,
        currentName: head.display,
        currentId: head.docId,
        next: '— (keep)',
        nextName: '',
        nextId: '',
        action: 'keep — the upgrade is held',
        gains: [],
        costs: [],
        why: 'The Mythical version is two levels away and strictly better.',
        replaces: false,
      },
      {
        slot: 'Hands',
        current: `${hands.display} #${hands.docId}`,
        currentName: hands.display,
        currentId: hands.docId,
        next: `${gauntlets.display} #${gauntlets.docId}`,
        nextName: gauntlets.display,
        nextId: gauntlets.docId,
        // Not empty for a replacement any more: an EQUIP that also fits sockets
        // has a second instruction, and this is the column about instructions.
        action: 'FIT Mark of Mogdrogen (component) + Kymon’s Vigil (augment)',
        gains: ['+10% Pierce Resistance', '+18% Chaos Resistance', '+214 Armor'],
        costs: ['−10% Vitality Resistance', '−15% Bleeding Resistance'],
        why: 'Chaos goes over cap; the component you lose is replaceable from the store.',
        replaces: true,
      },
      {
        slot: 'Belt',
        current: `${belt.display} #${belt.docId}`,
        currentName: belt.display,
        currentId: belt.docId,
        next: `${girdle.display} #${girdle.docId}`,
        nextName: girdle.display,
        nextId: girdle.docId,
        action: '',
        gains: ['+400 Health'],
        costs: ['−6% Aether Resistance', '−16% Vitality Resistance'],
        why: 'Aether is 74 points over cap, so it is free to spend.',
        replaces: true,
      },
      // A socket move keeps the item, so `next` is the keep marker and the move
      // itself lives in `action` — exactly as `verdictRows` derives it.
      {
        slot: 'Feet',
        current: `${feet.display} #${feet.docId}`,
        currentName: feet.display,
        currentId: feet.docId,
        next: '— (keep)',
        nextName: '',
        nextId: '',
        action: 'ADD-COMPONENT Mark of Mogdrogen',
        gains: ['+25% Bleeding Resistance'],
        costs: [],
        why: 'The socket is empty, so this costs nothing but the component.',
        replaces: false,
      },
      {
        slot: 'Ring 1',
        current: `${ring1.display} #${ring1.docId}`,
        currentName: ring1.display,
        currentId: ring1.docId,
        next: '— (keep)',
        nextName: '',
        nextId: '',
        action: 'RE-AUGMENT Kymon’s Vigil',
        gains: ['+40 Offensive Ability', '+12% Chaos Resistance'],
        costs: ['−15% Aether Resistance'],
        why: 'Aether is 74 points over cap; Offensive Ability is not.',
        replaces: false,
      },
      {
        slot: 'Weapon set 1 main',
        current: `${mainHand.display} #${mainHand.docId}`,
        currentName: mainHand.display,
        currentId: mainHand.docId,
        next: '— (keep)',
        nextName: '',
        nextId: '',
        action: 'SWAP-COMPONENT Bloodied Crystal',
        gains: ['+30% Bleeding Damage', '+8% Attack Speed'],
        costs: ['−40% Physical Damage'],
        why: 'Bleeding is where this build’s damage actually lands.',
        replaces: false,
      },
    ],
    itemNames: Object.fromEntries(
      [
        head,
        feet,
        hands,
        ring1,
        belt,
        mainHand,
        mythicalVisor,
        gauntlets,
        girdle,
        spareBlade,
        duplicateGauntlets,
      ].map((i) => [i.docId, i.display]),
    ),
    socketableNames: {
      's-mark-of-mogdrogen': 'Mark of Mogdrogen',
      's-kymon-s-vigil': 'Kymon’s Vigil',
      's-bloodied-crystal': 'Bloodied Crystal',
    },
  };
}

/**
 * Invented prose in the shape the prompt asks for.
 *
 * Every markdown construction the renderer handles appears once — headings,
 * both list kinds, a pipe table, a blockquote, a rule, inline code and
 * emphasis — because a story that only exercises paragraphs proves nothing
 * about the parser. The one thing the real prompt *forbids* is a per-slot
 * table; the table below is a resistance projection, which is allowed, and the
 * tool renders the per-slot one itself.
 */
const FIXTURE_ANSWER = `# Reaver, level 82 — Ultimate

Your damage is fine. Your **Bleeding resistance** is not: 38 against a cap of
80, on a character who spends most of Ultimate being bled at.

## What to do first

1. **Voidsteel Gauntlets** over the Silktouch Handwraps. Chaos 64 → 82.
2. Put a *Mark of Mogdrogen* in the boots — the socket is empty, so it is free.
3. Re-augment the ring: you are 74 points of Aether over cap and nothing is
   buying anything with it.

## What it costs

| Resistance | Now | After |
| --- | --- | --- |
| Bleeding | 38 | 63 |
| Chaos | 64 | 82 |
| Aether | 154 | 148 |

> The Aether loss is not a loss. Everything past 80 is decoration.

## What I am not counting

- Conversion, which the dossier states it does not apply.
- \`characterDefensiveAbility\` from the engine's own level floor.

---

Two levels from now the Mythical Ashfallen Visor replaces the head slot and
this whole answer is worth re-running.
`;

/**
 * An answer written to be hostile to the layout.
 *
 * The pretty fixture above proves the renderer works; this proves it does not
 * *break*, which is a different question and the one that bites in production.
 * A real answer is a few thousand words of model output over which this window
 * has no control: a table with more columns than the panel is wide, a record
 * path with no spaces in it, a fenced block of long lines. Each of those has its
 * own escape hatch — the table and the code block scroll inside themselves, the
 * prose breaks anywhere — and none of them may push the panel sideways, because
 * the pane clips rather than scrolls and the overflow would be silent.
 */
export const HOSTILE_ANSWER = `# An answer that does not fit

| Slot | Current | Proposed | Fire | Cold | Lightning | Acid | Vitality | Aether | Chaos | Bleeding |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Weapon set 1 main | Servitor's Slicer | Preposterously Ostentatious Harbinger's Girdle of the Everlasting Midnight Vigil | 74 | 74 | 74 | 100 | 94 | 148 | 82 | 63 |

The record is \`records/items/gearweapons/swords1h/d012_sword.dbr\` and the
identifier is PreposterouslyOstentatiousHarbingersGirdleOfTheEverlastingMidnightVigilOfDoom,
which has nothing in it a line may break at.

\`\`\`
records/items/gearaccessories/amulets/d101_amulet.dbr  itemLevel=84  offensivePhysicalMin=146
\`\`\`
`;

/**
 * A plausible slice of the model's reasoning, mid-run.
 *
 * Invented like everything else here, but shaped like the real thing: the live run
 * spent its first minutes exactly this way, working out that an over-cap resistance
 * is a resource rather than a strength. Long enough to overflow the box, with
 * paragraph breaks, because a transcript that fits proves nothing about one that
 * does not.
 */
export const FIXTURE_THINKING = `Let me start with the resistance matrix, because that is where the actual problem is going to be.

Aether Resistance is 179 permanent, 154 effective after the Ultimate penalty, against an 80 cap. That is +74 over cap — and over-cap resistance does nothing at all. So the three Wight Skin Powders are not defence, they are 45 points of nothing. That is the single largest free resource in this loadout and the reader is currently spending it on a stat they cannot use.

Meanwhile Bleeding Resistance is 63 permanent, 38 effective, against the same 80 cap. That is 42 points short, and this is a Bleeding build fighting things that bleed it back.

Now, what can actually reach Bleeding Resistance? The jewelry augments can: Sagethorn Powder is +15% Chaos Resistance and, unlike Wight Skin Powder, it adds +36% Pierce Damage and +36% Bleeding Damage instead of dead Aether Resistance. Glacier Dust is +15% Bleeding Resistance and +15% Pierce Resistance. So the three jewelry slots alone move Bleeding Resistance and Chaos Resistance without costing a single point of anything this character is using.

Let me check the amulet before I commit to that. Bloodmoon is +33% Pierce Damage, +60% Bleeding Damage, +8 Bleeding Damage over 3 Seconds, +5% Attack Speed, +40 Defensive Ability, +33 Cunning. Maiven's Lens is +25% Bleeding Resistance, +20% Chaos Resistance, +308 Health. That is a real trade and I should not pretend otherwise — but the Bleeding Damage comes back if a Dread Skull goes into the Lens, and there are two loose ones.

Wait. I should check whether any of Bloodmoon's +2 to skill lines are actually invested. Feral Hunger, Circle of Slaughter, Voracity — none of those appear in the invested list, so no skill rank moves and no resistance row moves with them. Good, that removes the objection.

So the shape of the answer is: seven empty armour augment slots end the elemental fragility, the three jewelry augments buy the Bleeding and Chaos deficit, and the amulet swap is what makes the arithmetic close instead of merely improve. Let me now cost the armour augments properly, because only four distinct ones exist for this character and all four are resistance…`;
