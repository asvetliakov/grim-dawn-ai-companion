/**
 * One slot-label matcher for every consumer of a plan's `slot` strings.
 *
 * The model writes slot labels back out of the dossier, and it is usually exact
 * — but the first live A/B produced `Main hand` / `Off hand` where the dossier's
 * headings are `Weapon set 1 main` / `Weapon set 1 off`, and the projection
 * skipped both verdicts (`unrecognized slot label`). Each carried `+10% Chaos
 * Resistance`, so the computed Chaos came out 20 points under what the plan
 * actually delivers: the projection was honest about the skips and still wrong
 * for the reader. An alias is a vocabulary miss, not a hallucination, so it is
 * normalized silently — resolved against the **active** weapon set, because a
 * model saying "main hand" means the hand holding a weapon.
 *
 * This lives in `src/shared/` because the same miss breaks every join on a
 * verdict's slot: the projection's `slotRef`, the renderer's verdict-to-loadout
 * join and its drift check. One matcher, not three — and no imports, so it sits
 * in the renderer's `types: []` graph and in core alike.
 */

/** `Weapon set 1 main` → `weaponset1main`. The join key for slot labels. */
export function slotKey(slot: string): string {
  return slot.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface WeaponHandRef {
  set: 1 | 2;
  hand: 0 | 1;
}

/**
 * The weapon slot a label names, aliases included.
 *
 * Recognized, on the normalized key: the dossier's own `weapon set N main/off`,
 * the set-numbered shorthand `weapon N main/off`, and the hand-only aliases
 * (`main hand`, `mainhand`, `off-hand weapon`), which resolve to `activeSet` —
 * a label naming no set means the hands holding weapons right now.
 */
export function weaponSlotRef(slot: string, activeSet: 1 | 2): WeaponHandRef | undefined {
  const key = slotKey(slot);
  const numbered = /^weapon(?:set)?([12])(main|off)(?:hand)?$/.exec(key);
  if (numbered) return { set: numbered[1] === '2' ? 2 : 1, hand: numbered[2] === 'main' ? 0 : 1 };
  // Bare `main`/`off` are excluded on purpose: one word is not a slot label.
  const handOnly = /^(main|off)(?:hand(?:weapon)?|weapon)$/.exec(key);
  if (handOnly) return { set: activeSet, hand: handOnly[1] === 'main' ? 0 : 1 };
  return undefined;
}

/**
 * The canonical join key for a verdict's slot label: weapon aliases resolved
 * against the active set, everything else `slotKey` unchanged.
 */
export function verdictSlotKey(slot: string, activeSet: 1 | 2): string {
  const weapon = weaponSlotRef(slot, activeSet);
  return weapon ? `weaponset${weapon.set}${weapon.hand === 0 ? 'main' : 'off'}` : slotKey(slot);
}
