/**
 * Faction slot → identity.
 *
 * The save stores reputations as a bare array of 47 slots: the *index is the
 * identity*, no names are written anywhere in the file. The engine's slot order
 * is not in the game data either — `records/game/gamefactions.dbr` holds the
 * roster as a *set* of keys (`factionSurvivors`, `factionUser8`, …), and the
 * `.arz` stores fields alphabetically, so reading the record back tells you
 * which factions exist but not what number each one is.
 *
 * The order below was derived from the two live saves and holds together on
 * every check available:
 *
 * - the eight non-`User` factions occupy slots 0–7, and `factionUser<N>` sits at
 *   slot `N + 6` (so `factionUser2` = 8, `factionUser22` = 28);
 * - every slot that comes out hostile is an enemy faction — Beasts (5, also the
 *   record's own `hiddenFactions` entry), Arkovian Undead (12), Aetherial
 *   Vanguard (18), Eldritch Horrors (22), Bloodbound (24);
 * - the slots that are never unlocked are the ones with no reputation to earn:
 *   Players (0), Neutral NPCs (7), Traps (25), The Dread (26), Asterkarn Dead (28);
 * - it resolves the contradiction the previous guessed table produced. Slot 11
 *   (Order of Death's Vigil) is Honored while slot 14 (Kymon's Chosen) is
 *   hostile, which is exactly the mutual exclusivity the game enforces; the old
 *   table put both at Honored;
 * - `_Suchka` wears three Wight Skin Powders, a Kurn augment the vendor only
 *   stocks at Honored. Kurn is `factionUser17` → slot 23, which reads 13,643
 *   (Honored). Under the old table Kurn landed on a slot that never reached it.
 *
 * `id` matches `DbFaction.id`, so a save slot joins straight onto the game
 * database's vendor stock (`db.vendorItems(id, tier)`). Names are the English
 * fallback for `cli parse`, which has no database to localize against.
 */

export interface FactionSlot {
  /** `DbFaction.id` — `f<n>` for the numbered user factions, else a slug. */
  id: string;
  /** English name, for output that has no database on hand. */
  name: string;
}

/** Slots 0–7: the fixed factions, in engine order. */
const FIXED_FACTIONS: readonly FactionSlot[] = [
  { id: 'player', name: 'Players' },
  { id: 'survivors', name: "Devil's Crossing" },
  { id: 'aetherials', name: 'Aetherials' },
  { id: 'cthonians', name: 'Chthonians' },
  { id: 'outlaws', name: "Cronley's Gang" },
  { id: 'beasts', name: 'Beasts' },
  { id: 'drifters', name: 'Rovers' },
  { id: 'neutralnpc', name: 'Neutral NPCs' },
];

/** `factionUser<N>` names, indexed by N. There is no `factionUser0` or `1`. */
const USER_FACTIONS: readonly (string | undefined)[] = [
  /*  0 */ undefined,
  /*  1 */ undefined,
  /*  2 */ 'Homestead',
  /*  3 */ 'Free Men of Corrigan Mine',
  /*  4 */ 'The Outcast',
  /*  5 */ "Order of Death's Vigil",
  /*  6 */ 'Arkovian Undead',
  /*  7 */ 'The Black Legion',
  /*  8 */ "Kymon's Chosen",
  /*  9 */ 'Coven of Ugdenbog',
  /* 10 */ 'Barrowholm',
  /* 11 */ 'Malmouth Resistance',
  /* 12 */ 'Aetherial Vanguard',
  /* 13 */ 'Cult of Bysmiel',
  /* 14 */ 'Cult of Dreeg',
  /* 15 */ 'Cult of Solael',
  /* 16 */ 'Eldritch Horrors',
  /* 17 */ 'Kurn',
  /* 18 */ 'Bloodbound',
  /* 19 */ 'Traps',
  /* 20 */ 'The Dread',
  /* 21 */ 'Noktukari',
  /* 22 */ 'Asterkarn Dead',
];

/** The offset from `factionUser<N>` to its save slot. */
const USER_SLOT_OFFSET = 6;

/** Save slot → faction identity, or undefined for a slot the roster never fills. */
export function factionSlot(index: number): FactionSlot | undefined {
  if (index < FIXED_FACTIONS.length) return FIXED_FACTIONS[index];
  const user = index - USER_SLOT_OFFSET;
  const name = USER_FACTIONS[user];
  return name === undefined ? undefined : { id: `f${user}`, name };
}

/**
 * The inverse: a `boostedFaction` key as the item records spell it → save slot.
 *
 * Booster records name their faction as `Survivors`, `Beasts`, `User8` — the
 * `gamefactions.dbr` key without its `faction` prefix — which is the same
 * identity `factionSlot` maps the other way. Nothing new is guessed: the
 * `User<N>` → `N + 6` rule and the eight fixed slugs above are the whole
 * implementation, and `User0` landing on Rovers is the fixed table agreeing
 * with the numbered one on the slot they share.
 */
export function factionSlotByKey(key: string): number | undefined {
  const wanted = key.trim().toLowerCase();
  const fixed = FIXED_FACTIONS.findIndex((f) => f.id === wanted);
  if (fixed >= 0) return fixed;
  const user = /^user(\d+)$/.exec(wanted);
  if (!user) return undefined;
  const slot = Number(user[1]) + USER_SLOT_OFFSET;
  return factionSlot(slot) ? slot : undefined;
}

export function factionName(index: number): string | undefined {
  return factionSlot(index)?.name;
}

/**
 * Reputation tier thresholds. Note "Trusted" is a *rep level* in game but not a
 * vendor market tier, so it is deliberately absent here — vendor augment
 * availability keys off these tiers only.
 */
export function factionTier(
  value: number,
): 'Hostile' | 'Neutral' | 'Friendly' | 'Respected' | 'Honored' | 'Revered' {
  if (value >= 25000) return 'Revered';
  if (value >= 10001) return 'Honored';
  if (value >= 5001) return 'Respected';
  if (value >= 1501) return 'Friendly';
  if (value < 0) return 'Hostile';
  return 'Neutral';
}
