/**
 * Where the window starts.
 *
 * Separate from `index.ts` — and importing nothing — so it can be tested. The
 * arithmetic is the kind that is wrong silently: a window that opens 40 px too
 * tall looks fine on the developer's screen and hides its footer under the Dock
 * on everyone else's.
 */

/** The size the layout is drawn for. Three columns fit at this width. */
export const DESIGN_SIZE = { width: 1920, height: 1080 } as const;

/** Below this the layout stops being usable at all, so it is the floor. */
export const MIN_SIZE = { width: 900, height: 640 } as const;

/**
 * Kept clear of the work area's edge. A window exactly the size of its space
 * reads as maximised and leaves no grab handles to resize it by.
 */
const MARGIN = 24;

/**
 * The largest of `DESIGN_SIZE` that actually fits in `work`.
 *
 * A 1920×1080 monitor does not have 1080 rows to give: the macOS menu bar and
 * Dock, or the Windows taskbar, are already spending some of them. Electron
 * calls what is left the **work area**, so that is what this measures against.
 *
 * It is a `min` and not "fill the work area", because a larger monitor should
 * open the window at the size the layout was drawn for rather than stretching
 * it across the screen — and a `max` against `MIN_SIZE`, because a screen too
 * small for the minimum is a screen where the window should overflow rather
 * than collapse into something unusable. The window is resizable either way;
 * this only decides where it starts.
 */
export function startingSize(work: { width: number; height: number }): { width: number; height: number } {
  return {
    width: Math.max(MIN_SIZE.width, Math.min(DESIGN_SIZE.width, work.width - MARGIN)),
    height: Math.max(MIN_SIZE.height, Math.min(DESIGN_SIZE.height, work.height - MARGIN)),
  };
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The work area as Electron reports it: a size *and* an origin. */
export interface WorkArea extends Bounds {}

/**
 * Where a remembered window should actually open.
 *
 * Restoring saved bounds verbatim is how a window ends up on a monitor that is
 * no longer plugged in — invisible, and indistinguishable from an app that
 * failed to start. So the size is clamped to what fits and the position is
 * clamped to keep a real overlap with the work area; a window that lands wholly
 * outside is re-centred rather than nudged, because nudging a window from a
 * 3840-wide desktop onto a laptop screen leaves it in a corner for no reason.
 *
 * `undefined` in means "nothing remembered": the caller opens at `startingSize`
 * and lets Electron centre it.
 */
export function restoreBounds(saved: Partial<Bounds> | undefined, work: WorkArea): Bounds | undefined {
  if (!saved || saved.width === undefined || saved.height === undefined) return undefined;
  if (![saved.x, saved.y, saved.width, saved.height].every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return undefined;
  }

  const width = Math.max(MIN_SIZE.width, Math.min(saved.width, work.width));
  const height = Math.max(MIN_SIZE.height, Math.min(saved.height, work.height));
  const x = saved.x!;
  const y = saved.y!;

  // "Enough of it is on screen to grab" — the title bar plus a corner. A window
  // one pixel inside the work area is technically restored and practically lost.
  const VISIBLE = 80;
  const onScreen =
    x + width > work.x + VISIBLE &&
    x < work.x + work.width - VISIBLE &&
    y + height > work.y &&
    y < work.y + work.height - VISIBLE;
  if (!onScreen) {
    return {
      x: Math.round(work.x + (work.width - width) / 2),
      y: Math.round(work.y + (work.height - height) / 2),
      width,
      height,
    };
  }
  return { x, y, width, height };
}
