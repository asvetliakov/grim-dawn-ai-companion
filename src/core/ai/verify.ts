/**
 * Mechanical checks on the advisor's structured plan.
 *
 * These are the claims a model can get wrong in ways a human reader will not
 * notice: an item id that exists nowhere in the dossier, a component proposed
 * for a slot its use-on restriction rejects, an extraction host that the plan
 * then also tells you to keep. Each is decidable from the document plus the
 * database, so it is decided here rather than trusted.
 *
 * The result is warnings, never a rejection. The prose is usually still worth
 * reading, and a plan that trips one check is a signal to the user (and to
 * whoever tunes the prompt), not an error to swallow the answer over.
 */

import type { DbItem } from '../db/types.js';
import type { ResolvedItem } from '../resolve.js';
import { SOCKET_VERDICTS, type AdvisorPlan } from './provider.js';

export type PlanWarningKind =
  | 'unknown-id'
  | 'unknown-socketable'
  | 'missing-target'
  | 'destroyed-host'
  | 'illegal-socket'
  | 'ambiguous-stat'
  | 'name-mismatch';

export interface PlanWarning {
  kind: PlanWarningKind;
  message: string;
}

export interface PlanCheckInput {
  /** Every id the context document defined, to the item it named. */
  itemsById: ReadonlyMap<string, ResolvedItem>;
  /**
   * Components and augments the document named, keyed by normalized display
   * name — the census in §8, everything installed in §5/§7, and the faction
   * stock in §9. A socketable outside this map was not offered to the model.
   */
  socketables: ReadonlyMap<string, DbItem>;
  /**
   * The same set keyed by the dossier id the document printed.
   *
   * Preferred over the name map wherever the answer supplies an id: a name has
   * to be normalized, stripped of a trailing "(loose)" and hoped to be unique,
   * while an id either matches or does not. Optional so a caller that has not
   * been updated — or an older answer that only carries names — still works.
   */
  socketablesById?: ReadonlyMap<string, DbItem>;
}

/**
 * The use-on flag a template class corresponds to: `ArmorProtective_Head` →
 * `head`, `WeaponMelee_Sword2h` → `sword2h`. The two vocabularies were built
 * from the same 23 gear families, so the suffix *is* the flag.
 */
export function slotFlagForClass(templateClass: string | undefined): string | undefined {
  if (!templateClass) return undefined;
  const suffix = templateClass.split('_')[1];
  return suffix ? suffix.toLowerCase() : undefined;
}

/** Display names arrive wrapped in whatever markdown the answer used. */
export function normalizeName(name: string): string {
  return name
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * A socketable name with a trailing parenthetical stripped: `Dread Skull
 * (loose)` → `dread skull`.
 *
 * The model annotates a target with its sourcing about as often as not, and
 * nothing in the prompt forbids it. Raising `unknown-socketable` for that would
 * be a false alarm on a *correct* move, which is worse than no check at all —
 * so the lookup tries the full name first and falls back to the stripped one.
 * Verified against the installed database: **0 of 491 socketables** have
 * parentheses in their display name, so the fallback cannot shadow a real item.
 * `test/db.test.ts` pins that, since the fallback stops being safe if it changes.
 */
export function nameWithoutQualifier(name: string): string {
  return normalizeName(name.replace(/\s*\([^()]*\)\s*$/, ''));
}

/**
 * Whether a name the answer gave and the name its id resolves to are the same
 * thing.
 *
 * Deliberately *not* string equality. A display name carries its affixes —
 * "Stealth Jacket of the Blind Assassin" — and a model quoting "Stealth Jacket"
 * is being terse, not wrong. Demanding an exact match would raise a warning on
 * a correct plan, which is worse than no check at all; the first run under the
 * `ambiguous-stat` rule proved that six times over.
 *
 * Containment either way is the test. It still catches the failure this exists
 * for — an id pointing at a different item than the prose argues for — because
 * two different items do not contain each other's names.
 */
export function namesAgree(given: string, actual: string): boolean {
  const a = nameWithoutQualifier(given);
  const b = normalizeName(actual);
  if (!a || !b) return true;
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * Damage types that read identically as damage, as resistance and as
 * retaliation. `+99% Pierce` and `+22 Fire` say nothing about which — and the
 * first live run put both meanings four words apart in one clause.
 */
const DAMAGE_TYPE_WORD =
  '(?:Physical|Pierce|Piercing|Fire|Cold|Lightning|Acid|Poison|Vitality|Aether|Chaos|Bleeding|Elemental|Burn|Frostburn|Electrocute)';

/**
 * The second word of a two-word damage type. Listing `Vitality Decay` among the
 * type names instead does *not* work: the engine backtracks out of the longer
 * alternative when the negative lookahead rejects it, matches the bare
 * `Vitality`, and then finds `Decay` where it wanted a qualifier. Letting the
 * link step over the word is what actually closes it.
 */
const TYPE_TAIL_WORD = '(?:\\bDecay\\b|\\bTrauma\\b)';

/**
 * What makes a stat reference unambiguous. A conversion arrow counts: in
 * `30% Vitality Damage → Pierce Damage` the arrow is what tells you the first
 * type is a source, and both ends still have to name their kind themselves.
 */
const QUALIFIER = '(?:Resist|Res\\b|Damage|Dmg|Retaliation|Retal|Armor|Armour|Duration|Conversion|Converted|→)';

/**
 * What may sit between a damage type and the qualifier that names its kind.
 *
 * Two real forms need it, and the first live run under this check tripped on
 * both — six warnings, every one a false alarm on correct output:
 *
 *  - the game's own compound stat names, `+24% Fire, Cold and Lightning
 *    Resistance`, where one qualifier covers three types;
 *  - a conversion, `30% Elemental→Pierce conversion`.
 *
 * A false alarm on a right answer is worse than no check, so the link may span
 * further type names, list punctuation and an arrow — but nothing else, which is
 * what keeps `+48 Pierce, +60 Acid Resistance` flagged on its first half.
 */
const TYPE_LINK = `(?:[*_\`)\\s,/]|→|->|\\band\\b|\\bto\\b|${TYPE_TAIL_WORD}|${DAMAGE_TYPE_WORD})`;

/**
 * A number followed by a bare damage type, with no qualifier after it.
 *
 * Decidable, so decided rather than hoped for. The sign is optional because
 * "but costs 35 Acid" — a real line from the first live run, meaning
 * resistance — carries none.
 */
const AMBIGUOUS_STAT = new RegExp(
  `[+\\-−]?\\s?\\d[\\d,.]*\\s?%?\\s+${DAMAGE_TYPE_WORD}\\b(?!${TYPE_LINK}*${QUALIFIER})`,
  'gi',
);

/**
 * Every bare damage-type stat reference in a piece of text, deduplicated.
 * Exported so the CLI can scan the prose as well as the structured plan.
 */
export function ambiguousStats(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(AMBIGUOUS_STAT)) found.add(match[0].trim());
  return [...found];
}

export interface PlanCheckOptions {
  /**
   * The answer's prose, scanned for bare stat references alongside the plan.
   * Optional because the plan alone is checkable — the CLI passes both.
   */
  answer?: string;
}

export function checkPlan(plan: AdvisorPlan, input: PlanCheckInput, opts: PlanCheckOptions = {}): PlanWarning[] {
  const warnings: PlanWarning[] = [];
  const warn = (kind: PlanWarningKind, message: string): void => {
    warnings.push({ kind, message });
  };

  const known = (id: string, where: string): boolean => {
    if (!id) return false;
    if (input.itemsById.has(id)) return true;
    warn('unknown-id', `${where} refers to \`#${id}\`, which is not an item id in the document`);
    return false;
  };

  /** An id/name pair that disagrees points at a different item than it argues for. */
  const nameAgrees = (id: string, name: string | undefined, where: string): void => {
    const item = input.itemsById.get(id);
    if (!item || !name) return;
    if (!namesAgree(name, item.display)) {
      warn('name-mismatch', `${where} names "${name}" but \`#${id}\` is ${item.display}`);
    }
  };

  for (const v of plan.verdicts) {
    const where = `${v.verdict} on ${v.slot}`;
    if (v.itemId) {
      known(v.itemId, where);
      nameAgrees(v.itemId, v.itemName, where);
    }
    if (v.verdict === 'EQUIP') {
      if (!v.target) warn('missing-target', `${where} names no candidate to equip`);
      else {
        known(v.target, `${where} target`);
        nameAgrees(v.target, v.targetName, `${where} target`);
      }
    }
    for (const enabler of v.enablers ?? []) known(enabler, `${where} enabler`);
    if (v.componentFrom) known(v.componentFrom, `${where} extraction host`);
    if (SOCKET_VERDICTS.includes(v.verdict)) checkSocket(v, input, warn);
  }

  for (const h of plan.hold) known(h.itemId, `HOLD entry`);
  for (const id of plan.sell) known(id, `SELL entry`);

  // Extraction destroys the host. A destroyed item cannot also be kept, held,
  // sold or re-equipped — the plan has to spend it exactly once.
  const hosts = new Map<string, string>();
  for (const v of plan.verdicts) {
    if (v.componentFrom) hosts.set(v.componentFrom, `${v.verdict} on ${v.slot}`);
  }
  for (const [host, source] of hosts) {
    const name = input.itemsById.get(host)?.display ?? `#${host}`;
    for (const v of plan.verdicts) {
      if (v.itemId === host) {
        warn(
          'destroyed-host',
          `${name} is destroyed by the extraction in ${source}, but also carries a ${v.verdict} verdict on ${v.slot}`,
        );
      }
      if (v.verdict === 'EQUIP' && v.target === host) {
        warn('destroyed-host', `${name} is destroyed by the extraction in ${source}, but ${v.slot} is told to equip it`);
      }
    }
    if (plan.hold.some((h) => h.itemId === host)) {
      warn('destroyed-host', `${name} is destroyed by the extraction in ${source}, but also appears in HOLD`);
    }
    if (plan.sell.includes(host)) {
      warn('destroyed-host', `${name} is destroyed by the extraction in ${source}, but also appears in SELL`);
    }
  }

  checkStatClarity(plan, opts.answer, warn);
  return warnings;
}

/**
 * Every stat reference must say which kind of stat it is. A summary the reader
 * has to open the dossier to disambiguate has failed at the one job a summary
 * has.
 */
function checkStatClarity(
  plan: AdvisorPlan,
  answer: string | undefined,
  warn: (kind: PlanWarningKind, message: string) => void,
): void {
  // A long answer can carry dozens; the warning is a pointer, not a transcript.
  const SHOWN = 8;
  const scan = (text: string, where: string): void => {
    const bare = ambiguousStats(text);
    if (bare.length === 0) return;
    const shown = bare.slice(0, SHOWN).map((b) => `"${b}"`).join(', ');
    warn(
      'ambiguous-stat',
      `${where} writes ${shown}${bare.length > SHOWN ? `, and ${bare.length - SHOWN} more` : ''} ` +
        'without saying Resistance / Damage / Retaliation',
    );
  };

  for (const v of plan.verdicts) {
    const where = `${v.verdict} on ${v.slot}`;
    if (v.reason) scan(v.reason, `${where} reason`);
    for (const gain of v.gains ?? []) scan(gain, `${where} gains`);
    for (const cost of v.costs ?? []) scan(cost, `${where} costs`);
  }
  for (const h of plan.hold) if (h.reason) scan(h.reason, 'HOLD reason');
  for (const n of plan.nextLevels ?? []) if (n.recommendation) scan(n.recommendation, 'Next levels recommendation');
  for (const m of plan.keyMoves ?? []) if (m.detail) scan(m.detail, `key move "${m.title}"`);
  if (plan.summary) scan(plan.summary, 'the summary');
  for (const note of plan.projected?.notes ?? []) scan(note, 'a projection note');
  if (answer) scan(answer, 'the answer');
}

function checkSocket(
  v: AdvisorPlan['verdicts'][number],
  input: PlanCheckInput,
  warn: (kind: PlanWarningKind, message: string) => void,
): void {
  if (!v.target) {
    warn('missing-target', `${v.verdict} on ${v.slot} names no component or augment`);
    return;
  }
  // Id first: it is exact. The name lookup stays as the fallback for an answer
  // that gave only a name, and for the socketables a caller has not indexed.
  const byId = v.targetId ? input.socketablesById?.get(v.targetId) : undefined;
  if (v.targetId && !byId) {
    warn(
      'unknown-socketable',
      `${v.verdict} on ${v.slot} gives targetId \`#${v.targetId}\`, which is not a component or augment id in the document`,
    );
  }
  const socketable =
    byId ??
    input.socketables.get(normalizeName(v.target)) ??
    input.socketables.get(nameWithoutQualifier(v.target));
  if (!socketable) {
    warn(
      'unknown-socketable',
      `${v.verdict} on ${v.slot} names "${v.target}", which is not a component or augment the document offered`,
    );
    return;
  }

  // An id and a name that disagree is the failure an id-only plan hides: the
  // prose argues for one component and the machine-readable half points at
  // another, and both halves look internally consistent.
  if (byId && !namesAgree(v.target, byId.name)) {
    warn(
      'name-mismatch',
      `${v.verdict} on ${v.slot} names "${v.target}" but its targetId \`#${v.targetId}\` is ${byId.name}`,
    );
  }

  // Without an item in the slot there is nothing to socket into — and without a
  // recorded restriction there is nothing to check. Both are silent: the first
  // is the model's problem to explain, the second is a data gap, not a fault.
  const host = v.itemId ? input.itemsById.get(v.itemId) : undefined;
  const flag = slotFlagForClass(host?.base?.slot);
  if (!flag || !socketable.allowedSlots?.length) return;

  if (!socketable.allowedSlots.includes(flag)) {
    warn(
      'illegal-socket',
      `${socketable.name} cannot go on ${host?.display ?? v.slot} — its use-on restriction does not accept ${flag}`,
    );
  }
}
