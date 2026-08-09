/**
 * Rarity colours.
 *
 * The game database records a rarity *name* and no colour at all — the engine's
 * palette is not in the data — so the hues live here, in the renderer, matching
 * what the game paints: white, yellow, green, blue, purple, and the quest
 * item's own tan.
 */

const CLASSES: Record<string, string> = {
  common: 'rarity-common',
  magical: 'rarity-magical',
  rare: 'rarity-rare',
  epic: 'rarity-epic',
  legendary: 'rarity-legendary',
  quest: 'rarity-quest',
};

export function rarityClass(rarity: string): string {
  return CLASSES[rarity.toLowerCase()] ?? CLASSES['common']!;
}
