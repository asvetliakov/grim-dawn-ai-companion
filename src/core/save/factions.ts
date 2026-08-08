/**
 * Faction index → display name.
 *
 * The save stores reputations as a bare array of 47 slots: the *index is the
 * identity*, no names are written anywhere in the file. Names below are guesses
 * at the game's internal faction order and are suffixed with `?` until
 * confirmed, so the uncertainty shows up in output instead of reading as fact.
 *
 * What the test characters do establish: slot 0 is a locked, always-zero
 * placeholder (so the list is 1-based), and slot 1 is a positive early-game
 * faction consistent with Devil's Crossing. Past slot 4 the ordering is
 * *known to be wrong somewhere* — the current guesses put both Kymon's Chosen
 * and Order of Death's Vigil at Honored on the same character, which the game
 * makes mutually exclusive. Stage 5 pins these down for real (they only start
 * mattering when faction vendor augments feed the context document); until
 * then only `unlocked` and `tier` are relied on.
 */
const FACTION_NAMES: readonly (string | undefined)[] = [
  /*  0 */ undefined,
  /*  1 */ "Devil's Crossing?",
  /*  2 */ 'Aetherials?',
  /*  3 */ 'Chthonians?',
  /*  4 */ "Cronley's Gang?",
  /*  5 */ undefined,
  /*  6 */ 'Rovers?',
  /*  7 */ undefined,
  /*  8 */ 'Homestead?',
  /*  9 */ 'The Outcast?',
  /* 10 */ "Order of Death's Vigil?",
  /* 11 */ "Kymon's Chosen?",
  /* 12 */ undefined,
  /* 13 */ undefined,
  /* 14 */ undefined,
  /* 15 */ undefined,
  /* 16 */ undefined,
  /* 17 */ 'Coven of Ugdenbog?',
  /* 18 */ 'Barrowholm?',
  /* 19 */ 'Malmouth Resistance?',
  /* 20 */ 'Cult of Bysmiel?',
  /* 21 */ 'Cult of Dreeg?',
  /* 22 */ 'Cult of Solael?',
  /* 23 */ undefined,
  /* 24 */ undefined,
  /* 25 */ undefined,
];

export function factionName(index: number): string | undefined {
  return FACTION_NAMES[index];
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
