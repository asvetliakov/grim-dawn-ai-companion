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
