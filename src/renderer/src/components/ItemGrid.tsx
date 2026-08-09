/**
 * A container, at the size the game draws it.
 *
 * Cells are one CSS variable (`--cell`) wide, so rescaling the whole app is a
 * one-line change; the lattice is a repeating gradient rather than a texture
 * because the game paints its inventory grid programmatically and ships no
 * cell art to borrow.
 */

import type { UiGrid } from '../../../shared/ipc.js';
import { ItemCell } from './ItemCell.js';

export function ItemGrid({ grid }: { grid: UiGrid }): React.ReactNode {
  return (
    <div
      className="item-grid"
      style={{
        width: `calc(${grid.width} * var(--cell))`,
        height: `calc(${grid.height} * var(--cell))`,
      }}
    >
      {grid.items.map((item) => {
        const p = item.position;
        const x = p.kind === 'inventory' || p.kind === 'stash' || p.kind === 'transfer' ? p.x : 0;
        const y = p.kind === 'inventory' || p.kind === 'stash' || p.kind === 'transfer' ? p.y : 0;
        return (
          <ItemCell
            key={item.docId}
            item={item}
            className="grid-item"
            // Absolute placement, in cells: the save stores a coordinate, not a
            // flow position, and two items never share one.
            style={{
              left: `calc(${x} * var(--cell))`,
              top: `calc(${y} * var(--cell))`,
              width: `calc(${item.cellsW} * var(--cell))`,
              height: `calc(${item.cellsH} * var(--cell))`,
            }}
          />
        );
      })}
    </div>
  );
}
