/**
 * How big a container is.
 *
 * Stash tabs — personal and transfer alike — carry their own `width`/`height`
 * in the save, so there is nothing to guess. **Inventory sacks do not**: the
 * save stores the item list and the coordinates, and the grid the game draws
 * them on is engine-side. The constants below are that grid, and they are the
 * one number in this file that could be wrong.
 *
 * Which is why every sack's dimensions are also grown to cover what it actually
 * holds. If a constant is too small, the grid gets bigger rather than clipping
 * an item into a cell that does not exist — a wrong constant costs a slightly
 * roomy container, never a missing item.
 */

import type { PositionedItem } from './save/types.js';

export interface GridDims {
  width: number;
  height: number;
}

/** Sack 0 — the main inventory bag, the one that is always there. */
export const MAIN_BAG: GridDims = { width: 12, height: 8 };

/** Every further sack — the bags bought from the inventory tabs. */
export const EXTRA_BAG: GridDims = { width: 8, height: 8 };

/**
 * The grid one inventory sack is drawn on: the constant for its index, widened
 * to fit anything that sticks out past it.
 *
 * `cells` reports an item's footprint in cells, which comes from its icon
 * texture (32 px per cell) and is therefore something only the caller — which
 * has the icon service — can answer. It is handed the item's index in the sack
 * as well, because the caller's footprints usually arrive as a parallel list.
 */
export function sackDims(
  items: readonly PositionedItem[],
  index: number,
  cells: (item: PositionedItem, itemIndex: number) => GridDims,
): GridDims {
  const base = index === 0 ? MAIN_BAG : EXTRA_BAG;
  let width = base.width;
  let height = base.height;
  for (const [i, item] of items.entries()) {
    const size = cells(item, i);
    width = Math.max(width, Math.round(item.x) + size.width);
    height = Math.max(height, Math.round(item.y) + size.height);
  }
  return { width, height };
}
