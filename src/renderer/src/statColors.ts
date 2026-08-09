/**
 * Colouring a stat line by what it is about.
 *
 * Grim Dawn colours its own tooltips by damage type and a player reads them
 * that way, so a wall of uniform text throws away a channel the reader already
 * knows how to use. The lines arrive as finished strings from the context
 * document's formatter — deliberately, so a tooltip and the dossier cannot
 * disagree — which means the type has to be recognised from the text rather
 * than carried alongside it.
 *
 * That is safe here for one specific reason: Stage 6C made "every stat
 * reference names its kind" a mechanical rule (`ambiguous-stat` in
 * `verify.ts`), so `Fire Resistance` and `Fire Damage` are both spelled out in
 * full and neither can be mistaken for the other. The match is on the type
 * word; the *kind* (damage vs resistance) is left to the words themselves.
 *
 * Order matters: the DoT names are checked before their parent types, because
 * "Internal Trauma" must not be read as Physical by way of a later rule.
 *
 * **A damage-over-time type gets its own shade of its parent's colour.** The
 * six DoT twins (Physical↔Internal Trauma, Fire↔Burn, Cold↔Frostburn,
 * Lightning↔Electrocute, Acid↔Poison, Vitality↔Vitality Decay) convert
 * together and read together, so they belong to the same family — but they are
 * separate stats that cap and resist separately, and painting `+30% Burn
 * Damage` in exactly the Fire colour hides that. Same hue, deliberately
 * lighter and less saturated: recognisably the family, not the same stat.
 * Bleeding is not one of these — it has no direct twin and never converts, so
 * it keeps a colour of its own.
 */

/** Longest, most specific names first. */
const TYPES: readonly { pattern: RegExp; type: string }[] = [
  { pattern: /internal trauma/i, type: 'trauma' },
  { pattern: /\bfrostburn\b/i, type: 'frostburn' },
  { pattern: /\belectrocute\b/i, type: 'electrocute' },
  { pattern: /vitality decay/i, type: 'decay' },
  { pattern: /\belemental\b/i, type: 'elemental' },
  { pattern: /fire, cold and lightning/i, type: 'elemental' },
  { pattern: /\bbleed(ing)?\b/i, type: 'bleeding' },
  { pattern: /\bpierce\b|\bpiercing\b/i, type: 'pierce' },
  { pattern: /\bphysical\b/i, type: 'physical' },
  // `Burn` before `Fire` is not enough on its own: "Fire Damage converted to
  // Burn" mentions both, and the earlier pattern in this list wins. The direct
  // type is the one the line is *about* in every phrasing the formatter emits.
  { pattern: /\bfire\b/i, type: 'fire' },
  { pattern: /\bburn(ing)?\b/i, type: 'burn' },
  { pattern: /\bcold\b|\bfrost\b/i, type: 'cold' },
  { pattern: /\blightning\b/i, type: 'lightning' },
  { pattern: /\bacid\b/i, type: 'acid' },
  { pattern: /\bpoison\b/i, type: 'poison' },
  { pattern: /\bvitality\b/i, type: 'vitality' },
  { pattern: /\baether\b/i, type: 'aether' },
  { pattern: /\bchaos\b/i, type: 'chaos' },
];

/** Non-elemental families worth their own colour. */
const KINDS: readonly { pattern: RegExp; kind: string }[] = [
  { pattern: /\barmor\b|\barmour\b|\babsorption\b|\bblock\b/i, kind: 'armor' },
  { pattern: /\bhealth\b|\bregenerat/i, kind: 'health' },
  { pattern: /\benergy\b|\bmana\b/i, kind: 'energy' },
  { pattern: /offensive ability|defensive ability|\bcrit\b|\bcritical\b/i, kind: 'ability' },
  { pattern: /attack speed|cast speed|movement speed|\bspeed\b/i, kind: 'speed' },
  { pattern: /physique|cunning|spirit/i, kind: 'attribute' },
  { pattern: /^\+\d+ to |\bskills?\b/i, kind: 'skill' },
];

/**
 * The CSS class for one rendered stat line, or '' when nothing recognisable is
 * in it. Never throws and never guesses twice — a line matches at most one
 * type and at most one kind, type first.
 */
export function statClass(line: string): string {
  for (const { pattern, type } of TYPES) if (pattern.test(line)) return `stat-${type}`;
  for (const { pattern, kind } of KINDS) if (pattern.test(line)) return `stat-${kind}`;
  return '';
}
