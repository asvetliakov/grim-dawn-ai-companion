/**
 * Stand-in art for the stories.
 *
 * The real icons are decoded out of the player's Grim Dawn install by the main
 * process and served over `gdicon://`, so in a browser there is nothing behind
 * that URL. Rather than let every item fall back to its two-letter placeholder —
 * which would make the layout look far emptier than it is — each fixture path
 * gets a deterministic SVG swatch, so spacing, footprints and the rarity palette
 * can all be judged with something in the box.
 *
 * Deterministic, because a screenshot that changes between runs is not a
 * regression test.
 */

const HUES = [12, 34, 58, 92, 140, 190, 214, 262, 292, 322];

function hashOf(path: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    hash ^= path.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export function fixtureIconUrl(texPath: string): string {
  const hash = hashOf(texPath);
  const hue = HUES[hash % HUES.length]!;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue} 45% 42%)"/>` +
    `<stop offset="1" stop-color="hsl(${hue} 50% 18%)"/>` +
    `</linearGradient></defs>` +
    `<rect x="4" y="4" width="56" height="56" rx="6" fill="url(#g)" stroke="hsl(${hue} 40% 62%)" stroke-width="2"/>` +
    `<path d="M18 44 L32 16 L46 44 Z" fill="hsl(${hue} 30% 82%)" opacity="0.55"/>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
