/**
 * The UI-facing layer: structured positions, grid dimensions, icon footprints
 * and the snapshot the window is painted from.
 *
 * The interesting assertion here is the packing one. Item footprints exist
 * nowhere in the game database — they are derived from the icon texture at 32 px
 * per cell — and a coordinate comes from the save. If either were wrong, items
 * would overlap on the grid. They do not, anywhere, across every container both
 * characters can reach, which is a far stronger check than reading the numbers
 * back out.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { EXTRA_BAG, MAIN_BAG, sackDims } from '@grimdawn/core/grid';
import { DESIGN_SIZE, MIN_SIZE, startingSize } from '../src/main/window-size.js';
import { createIconService, flatten, readPngSize, CELL_PX } from '@grimdawn/core/icons';
import { encodePng } from '@grimdawn/core/icons/png';
import { resolveCharacter, type ResolvedItem } from '@grimdawn/core/resolve';
import { parseGdc } from '@grimdawn/core/save/gdc';
import { accountFiles, loadSnapshot } from '../src/core/session.js';
import { resolveSettings } from '../src/core/settings.js';
import { buildUiSnapshot, type UiGrid, type UiSocketable } from '../src/core/view.js';
import type { PositionedItem } from '@grimdawn/core/save/types';

import {
  CHARACTERS,
  MISSING_GAME_MESSAGE,
  MISSING_SAVES_MESSAGE,
  characterSavePath,
  gameDb,
  haveGameInstall,
  haveSaves,
  haveLiveSaves,
  liveCharacters,
  primaryLiveCharacter,
} from './paths.js';

// ---------------------------------------------------------------------------
// readPngSize — no game needed
// ---------------------------------------------------------------------------

describe('readPngSize', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-png-'));

  it('reads the dimensions back out of a PNG we wrote', () => {
    const path = join(dir, 'a.png');
    writeFileSync(path, encodePng(64, 96, Buffer.alloc(64 * 96 * 4)));
    expect(readPngSize(path)).toEqual({ width: 64, height: 96 });
  });

  it('returns undefined rather than throwing for a file that is not a PNG', () => {
    const path = join(dir, 'b.png');
    writeFileSync(path, Buffer.from('not a png at all, but long enough to read'));
    expect(readPngSize(path)).toBeUndefined();
  });

  it('returns undefined for a file that does not exist', () => {
    expect(readPngSize(join(dir, 'nope.png'))).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// sackDims — no game needed
// ---------------------------------------------------------------------------

function at(x: number, y: number): PositionedItem {
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
    x,
    y,
  };
}

describe('startingSize', () => {
  it('leaves room for the dock on a 1080p screen', () => {
    // What macOS actually reports on a 1920×1080 display with the menu bar and
    // a docked Dock: never the full 1080. Asking for it opens the window with
    // its footer underneath the Dock.
    const { width, height } = startingSize({ width: 1920, height: 1055 });
    expect(width).toBeLessThan(DESIGN_SIZE.width);
    expect(height).toBeLessThan(1055);
  });

  it('opens at the design size on a screen with room to spare', () => {
    // Not "fill the work area": a 4K monitor should show the layout at the size
    // it was drawn for, not stretch it across the screen.
    expect(startingSize({ width: 3840, height: 2160 })).toEqual(DESIGN_SIZE);
  });

  it('never returns less than the minimum, even on a screen too small for it', () => {
    // The window overflows a tiny screen rather than collapsing into something
    // that cannot show a single pane.
    expect(startingSize({ width: 640, height: 400 })).toEqual({ ...MIN_SIZE });
  });

  it('is never larger than the work area it was given', () => {
    for (const work of [
      { width: 1440, height: 900 },
      { width: 1512, height: 945 },
      { width: 1920, height: 1055 },
      { width: 2560, height: 1415 },
    ]) {
      const size = startingSize(work);
      expect(size.width, `${work.width}×${work.height}`).toBeLessThanOrEqual(work.width);
      expect(size.height, `${work.width}×${work.height}`).toBeLessThanOrEqual(work.height);
    }
  });
});

describe('sackDims', () => {
  const oneCell = () => ({ width: 1, height: 1 });

  it('uses the main-bag constant for sack 0 and the extra-bag one after it', () => {
    expect(sackDims([], 0, oneCell)).toEqual(MAIN_BAG);
    expect(sackDims([], 1, oneCell)).toEqual(EXTRA_BAG);
    expect(sackDims([], 5, oneCell)).toEqual(EXTRA_BAG);
  });

  it('grows to cover an item past the constant, footprint included', () => {
    // A 2×4 weapon at (11,6) reaches x=13 and y=10 — both past the main bag.
    const dims = sackDims([at(11, 6)], 0, () => ({ width: 2, height: 4 }));
    expect(dims).toEqual({ width: 13, height: 10 });
  });

  it('never shrinks below the constant for an item well inside it', () => {
    expect(sackDims([at(1, 1)], 0, oneCell)).toEqual(MAIN_BAG);
  });

  it('is handed each item’s index, so footprints can arrive as a parallel list', () => {
    const sizes = [
      { width: 3, height: 1 },
      { width: 1, height: 5 },
    ];
    const dims = sackDims([at(0, 0), at(0, 0)], 1, (_item, i) => sizes[i]!);
    expect(dims).toEqual({ width: EXTRA_BAG.width, height: EXTRA_BAG.height });
  });
});

// ---------------------------------------------------------------------------
// Structured positions against the strings the document prints
// ---------------------------------------------------------------------------

const skipSaves = !haveSaves() || !haveGameInstall();
// `buildUiSnapshot` loads through the session, off the real save tree, so it
// needs characters that are actually there — not the fixtures the parsing
// tests are content with.
const skipLive = !haveLiveSaves() || !haveGameInstall();

describe.skipIf(skipSaves)('ItemPosition', () => {
  if (skipSaves) it.skip(haveSaves() ? MISSING_GAME_MESSAGE : MISSING_SAVES_MESSAGE, () => {});

  /**
   * `location` is what the context document prints and what its item ids are
   * assigned in the order of; `position` is the same fact for a grid. They are
   * two renderings of one truth, so every item must agree with itself.
   */
  function describePosition(item: ResolvedItem): string {
    const p = item.position;
    switch (p.kind) {
      case 'equipment':
        return `slot ${p.slot}`;
      case 'weapon':
        return `Weapon set ${p.set} ${p.hand}`;
      case 'inventory':
        return `bag ${p.sack + 1} (${p.x},${p.y})`;
      case 'stash':
      case 'transfer':
        return `tab ${p.tab + 1} (${p.x},${p.y})`;
      case 'materials':
        return 'materials store';
    }
  }

  it.each(CHARACTERS)('agrees with `location` for every item %s can reach', async (name) => {
    const db = await gameDb();
    const settings = resolveSettings();
    const save = parseGdc(readFileSync(characterSavePath(name)));
    const resolved = resolveCharacter(save, accountFiles(settings.saveDir), db);
    // Enough items to be worth checking. Not a fixed floor: the account-wide
    // stash is most of the count and belongs to the save *tree*, so a fixture
    // read on a machine whose tree has moved away resolves the character's own
    // gear and nothing else — which is a smaller number, not a broken one.
    expect(resolved.items.length).toBeGreaterThan(10);

    for (const item of resolved.items) {
      const p = item.position;
      if (p.kind === 'equipment' || p.kind === 'weapon') {
        // Equipment `location` is the slot's *name*, so the check is that the
        // index points at the right one rather than a string match.
        expect(item.source).toBe('equipped');
        if (p.kind === 'weapon') expect(item.location).toBe(describePosition(item));
      } else {
        expect(item.location).toBe(describePosition(item));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Icon footprints
// ---------------------------------------------------------------------------

describe.skipIf(!haveGameInstall())('getIconInfo', () => {
  if (!haveGameInstall()) it.skip(MISSING_GAME_MESSAGE, () => {});

  it('turns pixel dimensions into cells at 32 px each', async () => {
    const icons = createIconService();
    try {
      // Any texture with art will do; the assertion is the arithmetic.
      const info = await icons.getIconInfo('items/enchants/enchantm_black.tex');
      expect(info).toBeDefined();
      expect(info!.cellsW).toBe(Math.min(4, Math.max(1, Math.round(info!.width / CELL_PX))));
      expect(info!.cellsH).toBe(Math.min(4, Math.max(1, Math.round(info!.height / CELL_PX))));
      expect(info!.pngPath.endsWith(flatten('items/enchants/enchantm_black.tex'))).toBe(true);
    } finally {
      icons.close();
    }
  });

  it('clamps to 1..4 cells and answers undefined for a texture that is not there', async () => {
    const icons = createIconService();
    try {
      expect(await icons.getIconInfo('items/nope/does-not-exist.tex')).toBeUndefined();
      expect(await icons.getIconInfo('')).toBeUndefined();
    } finally {
      icons.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The snapshot the window paints
// ---------------------------------------------------------------------------

describe.skipIf(skipLive)('buildUiSnapshot', () => {
  if (skipLive) it.skip(haveLiveSaves() ? MISSING_GAME_MESSAGE : MISSING_SAVES_MESSAGE, () => {});

  /** Every cell an item covers, so overlaps and gaps are both visible. */
  function occupancy(grid: UiGrid): { cells: number; overlaps: number; outside: number } {
    const taken = new Set<string>();
    let overlaps = 0;
    let outside = 0;
    for (const item of grid.items) {
      const p = item.position;
      if (p.kind !== 'inventory' && p.kind !== 'stash' && p.kind !== 'transfer') continue;
      for (let dx = 0; dx < item.cellsW; dx++) {
        for (let dy = 0; dy < item.cellsH; dy++) {
          const key = `${p.x + dx},${p.y + dy}`;
          if (taken.has(key)) overlaps++;
          taken.add(key);
          if (p.x + dx >= grid.width || p.y + dy >= grid.height) outside++;
        }
      }
    }
    return { cells: taken.size, overlaps, outside };
  }

  // Loaded the way the app loads it — through the session, off the real save
  // directory — so this one runs against the tree as it is now rather than
  // against the fixtures. A snapshot of a character that has since been deleted
  // cannot be loaded that way, and the path from save tree to screen is exactly
  // what is being checked.
  it.each(liveCharacters())('builds a clone-safe, non-overlapping snapshot for %s', async (name) => {
    const db = await gameDb();
    const icons = createIconService();
    try {
      const snap = loadSnapshot(db, resolveSettings(), { character: name });
      const ui = await buildUiSnapshot(snap, icons);

      expect(ui.character).toBe(name);
      expect(ui.equipment).toHaveLength(12);
      expect(ui.weaponSets).toHaveLength(2);
      expect(ui.stats.resistances).toHaveLength(10);
      expect(ui.stats.armor).toHaveLength(6);
      expect(ui.stats.speeds).toHaveLength(3);

      // The damage profile crosses IPC faithfully — the exact rows the
      // aggregate ranked, in its order, none dropped and none invented.
      expect(ui.stats.damage.entries).toEqual(
        snap.aggregate.damage.ranked.map((e) => ({
          key: e.key,
          label: e.label,
          percent: e.percent,
          flat: e.flat,
          overTime: e.overTime,
        })),
      );
      expect(ui.stats.damage.totalPercent).toBe(snap.aggregate.damage.totalDamagePercent);
      expect(ui.stats.damage.composition.length).toBe(snap.aggregate.damage.weaponAttack.composition.length);

      // Nothing crossing IPC may be a Map, a class instance or a function.
      expect(() => structuredClone(ui)).not.toThrow();

      // The whole point of `docId`: 7B joins advice onto the grid with it, so it
      // has to be the *document* id and it has to be unique.
      const ids = new Set<string>();
      const every = [
        ...ui.equipment,
        ...ui.weaponSets.flat(),
        ...ui.bags.flatMap((g) => g.items),
        ...ui.personalStash.flatMap((g) => g.items),
        ...ui.transferStash.flatMap((g) => g.items),
        ...ui.materials,
      ].filter((i) => i !== null);
      for (const item of every) {
        expect(ids.has(item.docId), `duplicate docId ${item.docId}`).toBe(false);
        ids.add(item.docId);
        expect(snap.doc.itemsById.has(item.docId)).toBe(true);
      }

      // Footprints come from the icon texture and coordinates from the save.
      // If either were wrong these would collide.
      for (const grid of [...ui.bags, ...ui.personalStash, ...ui.transferStash]) {
        const { overlaps, outside } = occupancy(grid);
        expect(overlaps, `${grid.label} overlaps`).toBe(0);
        expect(outside, `${grid.label} items outside the grid`).toBe(0);
      }
    } finally {
      icons.close();
    }
  });

  /**
   * The socketable dictionary, which is what makes a *proposed* component
   * renderable at all: it is installed nowhere, so there is no item to read its
   * stats off, and the plan names it by an id that must be the same id the
   * dossier handed out.
   */
  it('offers every dossier socketable by the id the plan will use', async () => {
    const db = await gameDb();
    const icons = createIconService();
    try {
      const snap = loadSnapshot(db, resolveSettings(), { character: primaryLiveCharacter() });
      const ui = await buildUiSnapshot(snap, icons);

      const ids = Object.keys(ui.socketables);
      expect(ids.length).toBeGreaterThan(10);
      for (const id of ids) {
        expect(snap.doc.socketablesById.has(id), `${id} is not a dossier id`).toBe(true);
        expect(ui.socketables[id]!.id).toBe(id);
        expect(ui.socketables[id]!.name.length).toBeGreaterThan(0);
      }

      // The two id spaces share one namespace on purpose — the model is told to
      // identify everything by id — so nothing may answer to both.
      for (const id of ids) expect(snap.doc.itemsById.has(id), `${id} collides with an item`).toBe(false);

      // An installed component carries the same id as the loose one, which is
      // the join "take that out of this and put it in here" depends on.
      const installed = [...ui.equipment, ...ui.weaponSets.flat()]
        .filter((i) => i !== null)
        .flatMap((i) => [i.tooltip.component, i.tooltip.augment])
        .filter((p) => p !== undefined);
      expect(installed.length).toBeGreaterThan(0);
      for (const part of installed) {
        if (!part.id) continue; // worn but never offered as a candidate
        expect(ui.socketables[part.id]?.name).toBe(part.name);
        // And the *same* stats, whether it is being read off its host or out of
        // the dictionary. The installed copy used to have its `Grants:` line
        // lifted into the host item's granted-skill block, which left a
        // component whose whole point is the buff it grants describing itself
        // as two small stat lines — and credited the item with a skill that
        // leaves the moment the component does.
        expect(ui.socketables[part.id]?.lines).toEqual(part.lines);
      }

      // Concretely: plenty of components grant a skill, and they say so
      // themselves. (Asserted over the dictionary rather than over what this
      // character happens to be wearing, which changes every time they re-gear.)
      const granting = Object.values(ui.socketables).filter((p) => p.lines.some((l) => l.startsWith('Grants: ')));
      expect(granting.length, 'no socketable grants a skill').toBeGreaterThan(0);

      // Stated once, on the part it belongs to: an item's own granted-skill
      // block must not repeat what its component or augment already said.
      for (const it of [...ui.equipment, ...ui.weaponSets.flat()].filter((i) => i !== null)) {
        const fromParts = [...(it.tooltip.component?.lines ?? []), ...(it.tooltip.augment?.lines ?? [])];
        for (const line of it.tooltip.grantedSkills) {
          expect(fromParts, `${it.display} repeats a socketable's grant`).not.toContain(line);
        }
      }
    } finally {
      icons.close();
    }
  });

  /**
   * Where to obtain a socketable. A proposed one is installed nowhere, so its
   * tooltip has to answer "where do I get one" — and every answer is already
   * derived for the dossier (§8's census, the recipe view, §9's faction stock),
   * so the dictionary carries the same facts as prose lines.
   */
  it('says where to obtain a socketable', async () => {
    const db = await gameDb();
    const icons = createIconService();
    try {
      const snap = loadSnapshot(db, resolveSettings(), { character: primaryLiveCharacter() });
      const ui = await buildUiSnapshot(snap, icons);
      const all = Object.values(ui.socketables);

      // Faction augments name the vendor, the tier and the price.
      const buys = all.filter((p) => p.obtain?.some((l) => l.startsWith('Buy: ')));
      expect(buys.length, 'no socketable says which faction sells it').toBeGreaterThan(0);
      for (const p of buys) {
        expect(p.obtain!.find((l) => l.startsWith('Buy: '))).toMatch(
          /^Buy: .+ \((Friendly|Respected|Honored|Revered)\), [\d,]+ iron$/,
        );
      }

      // Loose copies say which container they are in; this character's live
      // components sit in the materials store.
      const onHand = all.filter((p) => p.obtain?.some((l) => l.startsWith('On hand: ')));
      expect(onHand.length, 'no socketable reports a loose copy').toBeGreaterThan(0);

      // A learned blueprint shows up as a craft line.
      const craftable = all.filter((p) => p.obtain?.some((l) => l.startsWith('Craftable now')));
      expect(craftable.length, 'no socketable reports a learned blueprint').toBeGreaterThan(0);

      // The installed copy carries the same obtain lines as the dictionary
      // entry — one derivation, keyed by record, read from both places.
      const installed = [...ui.equipment, ...ui.weaponSets.flat()]
        .filter((i) => i !== null)
        .flatMap((i) => [i.tooltip.component, i.tooltip.augment])
        .filter((p): p is UiSocketable => p !== undefined && p.id !== undefined);
      for (const part of installed) {
        expect(part.obtain).toEqual(ui.socketables[part.id!]?.obtain);
      }
    } finally {
      icons.close();
    }
  });

  it('renders tooltips with the context document’s own formatting', async () => {
    const db = await gameDb();
    const icons = createIconService();
    try {
      const snap = loadSnapshot(db, resolveSettings(), { character: primaryLiveCharacter() });
      const ui = await buildUiSnapshot(snap, icons);
      const worn = ui.equipment.filter((i) => i !== null);
      expect(worn.length).toBeGreaterThan(6);

      for (const item of worn) {
        const lines = item.tooltip.blocks.flatMap((b) => b.lines);
        expect(lines.length, `${item.display} has no stat lines`).toBeGreaterThan(0);
        // The document's cardinal rule: no raw `key: value` fallbacks, and every
        // stat reference names its kind.
        for (const line of lines) expect(line).not.toMatch(/^`[a-z]+[A-Za-z]*:/);
        // Everything worn is by definition equippable.
        expect(item.tooltip.meetsRequirements, `${item.display} fails its own check`).toBe(true);
      }
    } finally {
      icons.close();
    }
  });

  it('sizes stash tabs from the save and bags from the constants', async () => {
    const db = await gameDb();
    const icons = createIconService();
    try {
      const snap = loadSnapshot(db, resolveSettings(), { character: primaryLiveCharacter() });
      const ui = await buildUiSnapshot(snap, icons);

      expect(ui.bags[0]).toMatchObject({ width: MAIN_BAG.width, height: MAIN_BAG.height });
      for (const bag of ui.bags.slice(1)) {
        expect(bag.width).toBeGreaterThanOrEqual(EXTRA_BAG.width);
        expect(bag.height).toBeGreaterThanOrEqual(EXTRA_BAG.height);
      }
      // Stash tabs carry their own dimensions; they must come from the save.
      ui.personalStash.forEach((tab, i) => {
        expect(tab.width).toBe(snap.save.personalStash[i]!.width);
        expect(tab.height).toBe(snap.save.personalStash[i]!.height);
      });
      ui.transferStash.forEach((tab, i) => {
        expect(tab.width).toBe(snap.account.stash!.sacks[i]!.width);
        expect(tab.height).toBe(snap.account.stash!.sacks[i]!.height);
      });
    } finally {
      icons.close();
    }
  });
});
