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

import { acceptsAugment, acceptsComponent } from '../context/builder.js';
import type { CandidateProjection, SlotProjection } from '../context/projections.js';
import { RESIST_COLUMNS, resistContributions, type ResistKey } from '../mechanics/stats.js';
import type { DbItem, StatValue } from '@grimdawn/core/db/types';
import type { ResolvedItem } from '@grimdawn/core/resolve';
import type { PlanProjection } from './envelope.js';
import {
  SOCKET_VERDICTS,
  type AdvisorPlan,
  type PlanWarning,
  type PlanWarningKind,
} from './provider.js';

/**
 * Both live in `provider.ts` — a warning is part of the plan's own vocabulary,
 * like `VerdictRow`, and a stored advice envelope carries them across the IPC
 * boundary where nothing may reach a module that imports `node:fs`.
 */
export type { PlanWarning, PlanWarningKind } from './provider.js';

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
  /**
   * The gear ids the document actually offered — §7's ranked candidates plus
   * its carried-but-unranked line. The coverage check runs only when this is
   * given: an item the model was never shown cannot be demanded a verdict on.
   */
  candidateIds?: ReadonlySet<string>;
  /**
   * Component ids that are *free* to install — a loose copy on hand, or a
   * learned blueprint craftable right now (`ContextDoc.freeComponentIds`; §8's
   * census computes both). The empty-socket check runs only when this is given,
   * and only against these: an installed-only copy costs its host, so walking
   * past an empty socket for lack of a free component is a judgement, not an
   * oversight.
   */
  freeComponentIds?: ReadonlySet<string>;
  /**
   * Compute the plan's projection — the verdicts applied to the save the run
   * saw, re-aggregated. Supplied as a callback because the projection needs the
   * save, the account files and the database, which the check otherwise has no
   * business holding; and because it has to run **inside the repair loop**, on
   * each candidate plan, for `overstated-cap` to be repairable at all. The
   * check runs only when this is given, and a projection that degrades to
   * `undefined` checks nothing — same posture as every other optional input.
   */
  project?: (plan: AdvisorPlan) => PlanProjection | undefined;
  /**
   * §7's projected swap under each candidate, by dossier id
   * (`ContextDoc.projections`). What the hold and KEEP checks read: whether a
   * candidate improves anything, and whether the gap it opens was `closable`.
   * Both checks run only when this is given.
   */
  candidateProjections?: ReadonlyMap<string, CandidateProjection>;
  /**
   * Augment ids that can be had — loose on hand, or at a faction tier the
   * character has reached (`ContextDoc.freeAugmentIds`). The empty-augment
   * check runs only when this and `project` are given.
   */
  freeAugmentIds?: ReadonlySet<string>;
}

/**
 * The use-on flag a template class corresponds to: `ArmorProtective_Head` →
 * `head`, `WeaponMelee_Sword2h` → `sword2h`. The two vocabularies were built
 * from the same 23 gear families, so the suffix *is* the flag.
 */
/** `a, b and c` — warnings are read by a person, not grepped. */
function andList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

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
 *
 * `Absorb` and `Share` are qualifiers too, added after the first post-8B live
 * run's only surviving warning turned out to be two false alarms: "525
 * Physical/Pierce absorption proc" names absorption — a stat kind of its own,
 * the one statfmt prints as `Physical Damage Absorption` — and "the 10%
 * Frostburn share of the weapon attack" is a §4 composition share, which a
 * resistance cannot be.
 */
const QUALIFIER =
  // `Absor`, not `Absorb`: the noun is absor*p*tion, so the verb stem misses it.
  '(?:Resist|Res\\b|Damage|Dmg|Retaliation|Retal|Armor|Armour|Duration|Conversion|Converted|Absor|Share|→)';

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
 * A label–value list — `Fire 92, Cold 90, Lightning 80` — names each type as a
 * row label with its number *after* it, so what the matcher glues together
 * (`92, Cold`) is the seam between two entries, not a stat. Both live runs
 * wrote their projected-resistance summary in exactly this shape and the
 * repair round spent a full second call on it each time — the
 * false-alarm-on-a-right-answer this check must not produce. A type name
 * followed by its own unsigned number is therefore not flagged. A *signed*
 * number after the type is a new stat, which keeps `+48 Pierce, +60 Acid`
 * flagged on both halves; and the whitespace is same-line only, so a stat that
 * ends a line stays checkable whatever the next line opens with.
 */
const LIST_VALUE_AFTER = `(?:[ \\t]*${TYPE_TAIL_WORD})?[ \\t]*:?[ \\t]*\\d`;

/**
 * A number followed by a bare damage type, with no qualifier after it.
 *
 * Decidable, so decided rather than hoped for. The sign is optional because
 * "but costs 35 Acid" — a real line from the first live run, meaning
 * resistance — carries none.
 */
const AMBIGUOUS_STAT = new RegExp(
  `[+\\-−]?\\s?\\d[\\d,.]*\\s?%?\\s+${DAMAGE_TYPE_WORD}\\b(?!${TYPE_LINK}*${QUALIFIER})(?!${LIST_VALUE_AFTER})`,
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
    // A CRAFT whose target is a component is a socket install by another name
    // (the projection treats it as one), so its legality is checked the same way.
    else if (v.verdict === 'CRAFT' && v.targetId && input.socketablesById?.get(v.targetId)) checkSocket(v, input, warn);
    // The extra sockets. Checked against the item the slot will actually hold —
    // for an `EQUIP` that is the candidate, and checking the outgoing item's
    // class instead would clear a component for the wrong kind of gear.
    checkFits(v, input, warn);
  }

  // A hold is a recommendation, not a status.
  //
  // Every candidate that fails a requirement is listed in §12 so a threshold
  // can be costed against everything it unlocks — and the first live answers
  // read that as a to-do list, marking HOLD on every over-levelled item in the
  // stash whether or not it beat what the character was already wearing. So a
  // hold has to say what it is *for*: the slot, the item it would displace, and
  // what it wins by. Those three are decidable, so they are decided here rather
  // than hoped for.
  for (const h of plan.hold) {
    const where = `HOLD on ${h.itemName ?? `#${h.itemId}`}`;
    known(h.itemId, 'HOLD entry');
    nameAgrees(h.itemId, h.itemName, where);
    const missing: string[] = [];
    if (!h.slot?.trim()) missing.push('which slot it is for');
    if (!h.beats?.trim()) missing.push('which item it would replace');
    if (!h.gains?.length) missing.push('what it gains over that item');
    // A hold without an exit condition is "keep this" — a stash decision, not
    // a plan. The condition is a level, attribute points, or the kind of drop
    // that would cover what putting the item on opens today; any of them is a
    // sentence, and the UI shows it beside the item.
    if (!h.until?.trim()) missing.push('until when it is held');
    if (missing.length) {
      warn(
        'unjustified-hold',
        `${where} does not say ${andList(missing)} — being unequippable is not a reason to keep an item`,
      );
    }
    if (h.beats) known(h.beats, `${where} beats`);
    // Holding an item to replace itself is the degenerate form of the same
    // mistake: the plan has restated the status quo as a recommendation.
    if (h.beats && h.beats === h.itemId) {
      warn('unjustified-hold', `${where} says it replaces itself`);
    }
  }
  for (const id of plan.sell) {
    if (!known(id, `SELL entry`)) continue;
    // Stored items are being kept on purpose. The player moved them there, so
    // "sell it" second-guesses a decision the dossier already shows was made —
    // a stored item may be recommended for wearing or holding, never disposal.
    const item = input.itemsById.get(id);
    if (item && (item.source === 'stash' || item.source === 'transfer')) {
      warn(
        'sell-in-stash',
        `SELL on ${item.display}, which is stored in the ${item.source === 'transfer' ? 'transfer stash' : 'personal stash'} — stored items are kept on purpose; leave it unmentioned, or HOLD it if it is worth wearing one day`,
      );
    }
  }
  // Unlocks are item references like any other; a hallucinated one would
  // otherwise sail through because nothing else reads this array.
  //
  // And `nextLevels` is a commit list, not a walk down §12's ladder. §12 groups
  // *every* blocked candidate so a threshold can be costed, and most of those
  // items lose to what is already worn — a live gpt-5.6 run mirrored the whole
  // thing back as sixteen rows, fourteen of them "skip, off-build", with one
  // row naming twenty-eight unlocks of which two mattered. The UI renders every
  // id as a thing to go and find, so an unlock the plan is not holding for is a
  // reader sent hunting for an item the same answer tells them to skip. Held is
  // the test because holding is what "I will put this on at the threshold"
  // means; an empty `unlocks` is exempt — a farming target or the one line that
  // says nothing is worth committing to has no item to name.
  const heldIds = new Set(plan.hold.map((h) => h.itemId));
  for (const step of plan.nextLevels ?? []) {
    const stray: string[] = [];
    for (const id of step.unlocks) {
      // An unknown id has already been reported; do not charge it twice.
      if (!known(id, `Next levels ("${step.threshold}")`)) continue;
      if (!heldIds.has(id)) stray.push(input.itemsById.get(id)?.display ?? `#${id}`);
    }
    if (stray.length === 0) continue;
    // The offending entry is the one that names two dozen items, so the message
    // that reports it must not name two dozen items back.
    const named = stray.length > 4 ? `${stray.slice(0, 4).join(', ')} and ${stray.length - 4} more` : andList(stray);
    warn(
      'uncommitted-next-level',
      `Next levels ("${step.threshold}") lists ${named}, which the plan does not HOLD — ` +
        `a threshold's unlocks are the items you are keeping for it, not §12's costing list. ` +
        `Drop ${stray.length === 1 ? 'it' : 'them'}, and drop the whole entry if nothing held is left in it`,
    );
  }

  // Coverage: everything the document offered from the *carried bags* must end
  // somewhere. A verdict, a hold or a sell all count; so does being spent as an
  // extraction host or named as an enabler — those are dispositions too. Stash
  // candidates are exempt for the same reason selling them is an error: stored
  // items owe the plan nothing.
  if (input.candidateIds) {
    const addressed = new Set<string>();
    for (const v of plan.verdicts) {
      addressed.add(v.itemId);
      if (v.target) addressed.add(v.target);
      if (v.targetId) addressed.add(v.targetId);
      if (v.componentFrom) addressed.add(v.componentFrom);
      for (const e of v.enablers ?? []) addressed.add(e);
    }
    for (const h of plan.hold) addressed.add(h.itemId);
    for (const id of plan.sell) addressed.add(id);
    for (const id of input.candidateIds) {
      if (addressed.has(id)) continue;
      const item = input.itemsById.get(id);
      if (!item || item.source !== 'inventory') continue;
      warn(
        'unaddressed-item',
        `${item.display} (\`#${id}\`) is in the carried bags and was offered in §7, but the plan gives it no verdict, HOLD or SELL`,
      );
    }
  }

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

  // One projection serves every check that needs one — it is a full
  // re-aggregation, and it runs inside the repair loop on each candidate plan.
  const projection = input.project?.(plan);
  checkEmptySockets(plan, input, projection, warn);
  checkOverstatedCaps(plan, projection, warn);
  checkAvoidableHolds(plan, input, warn);
  checkUnarguedKeeps(plan, input, warn);
  checkStatClarity(plan, opts.answer, warn);
  return warnings;
}

/** The projection of `item` into `slot`, tolerant of the label's case and spacing. */
function projectionInto(
  projections: ReadonlyMap<string, CandidateProjection>,
  id: string,
  slot: string | undefined,
): SlotProjection | undefined {
  const cp = projections.get(id);
  if (!cp || !slot) return undefined;
  const wanted = slot.trim().toLowerCase();
  return cp.targets.find((t) => t.slot.toLowerCase() === wanted);
}

/**
 * Whether the projection says the candidate is worth arguing about: wearable
 * now, improves something the projection tracks, and whatever resistance it
 * opens is closable by the loadout's own sockets. Not a judgement that it is
 * better — that is the model's — only that "it opens a gap" is not the answer.
 */
function arguable(t: SlotProjection): boolean {
  if (!t.projection || t.noTrackedGain || !t.wearable) return false;
  if (t.gaps.length && !t.closable) return false;
  return true;
}

/** The witness in a few words, for a warning that has to say what the line said. */
function witnessSummary(t: SlotProjection): string {
  const w = t.closable;
  if (!w) return '';
  const bits = w.reaugments.map((r) => `${r.augment.item.name} on ${r.slot}`);
  if (w.fill) bits.push(`${w.fill.component.item.name} in the ${t.slot} socket`);
  return bits.join(', ');
}

/**
 * A hold waiting on a drop, on a candidate whose §7 line said the gap was
 * closable. The drop hold exists for a cost nothing in the dossier covers —
 * and this one was covered, with ids, on the line the hold quotes from. Only
 * a hold with no level or attribute condition qualifies; a set the swap would
 * break, or a dual-wield enabler it would remove, is a cost the witness does
 * not address and keeps the hold legitimate. Restricted to gaps the tool
 * closed: a hold on a swap that opens no gap at all may be waiting on sustain
 * or a rank, which is a judgement the projection does not make.
 */
function checkAvoidableHolds(
  plan: AdvisorPlan,
  input: PlanCheckInput,
  warn: (kind: PlanWarningKind, message: string) => void,
): void {
  const projections = input.candidateProjections;
  if (!projections) return;
  for (const h of plan.hold) {
    if (h.needs?.levels || h.needs?.attributePoints) continue;
    const t = projectionInto(projections, h.itemId, h.slot);
    if (!t?.projection || t.noTrackedGain || !t.gaps.length || !t.closable) continue;
    if (t.setPieces.some((s) => s.before >= 2 && s.after < s.before)) continue;
    if (t.notes.some((n) => n.includes('dual-wield'))) continue;
    const name = input.itemsById.get(h.itemId)?.display ?? `#${h.itemId}`;
    const gaps = t.gaps.map((g) => `${g.label} Resistance ${g.short} short`).join(', ');
    warn(
      'avoidable-hold',
      `HOLD on ${name} for ${t.slot} waits on a drop, but the gap its swap opens (${gaps}) is closable — ` +
        `§7's line names the re-augment (${witnessSummary(t)}). Either EQUIP it with that re-augment (in \`fits\` and ` +
        `RE-AUGMENT verdicts), or KEEP the worn item and say which axis it wins on, and by how much`,
    );
  }
}

/**
 * A KEEP that names *none* of the candidates it is keeping over, where a
 * candidate is wearable, improves a tracked figure and opens nothing the tool
 * could not close. The check is on the naming: an id or a name in the
 * verdict's reason, gains or costs. Naming one is enough — a weapon slot can
 * have a dozen arguable candidates, and the first live run under this check
 * argued the best of them and was told to argue the other ten, which is not
 * the failure this exists for. What the worn item wins on is the model's
 * judgement; that it said so about *something* is the tool's to check. A
 * sold item is not checked on its own: a slot whose KEEP argues nothing
 * already warns, and one whose KEEP argues its strongest rival has argued.
 */
function checkUnarguedKeeps(
  plan: AdvisorPlan,
  input: PlanCheckInput,
  warn: (kind: PlanWarningKind, message: string) => void,
): void {
  const projections = input.candidateProjections;
  if (!projections) return;

  const named = (text: string, id: string, item: ResolvedItem | undefined): boolean =>
    text.includes(`#${id}`) ||
    (!!item && text.includes(normalizeName(item.display))) ||
    (!!item?.base && text.includes(normalizeName(item.base.name)));
  const list = (items: string[]): string => (items.length > 3 ? `${items.slice(0, 3).join(', ')} and ${items.length - 3} more` : andList(items));

  for (const v of plan.verdicts) {
    if (v.verdict !== 'KEEP') continue;
    const text = normalizeName([v.reason, ...(v.gains ?? []), ...(v.costs ?? [])].join(' '));
    const slot = v.slot.trim().toLowerCase();
    const arguableHere: string[] = [];
    let argued = false;
    for (const [id, cp] of projections) {
      const t = cp.targets.find((x) => x.slot.toLowerCase() === slot);
      if (!t || !arguable(t)) continue;
      const item = input.itemsById.get(id);
      if (named(text, id, item)) argued = true;
      arguableHere.push(`${item?.display ?? '?'} (\`#${id}\`)`);
    }
    if (arguableHere.length && !argued) {
      warn(
        'unargued-keep',
        `KEEP on ${v.slot} names none of ${list(arguableHere)} — each is wearable now, improves a figure the projection tracks, ` +
          `and opens no resistance gap the tool could not close; say which one the worn item beats, on which axis, and by how much`,
      );
    }
  }
}

/**
 * A resistance the tally claims capped that the computed projection proves is
 * not.
 *
 * Deliberately the *narrowest* reading of a projection disagreement. A model
 * reporting the permanent band, or an honest under-cap figure it argued for,
 * is making a call the notes can carry; a tally that says "capped" while the
 * plan's own verdicts take the resistance under cap is an arithmetic slip the
 * reader acts on — both live gpt-5.6 runs dropped the same `-28% Acid
 * Resistance` cost this way, on the same medal. The claim threshold is the
 * computed cap (`capAfter`, which follows any `+% Maximum Resistance` moves)
 * and the shortfall threshold is the cross-check's own ±2, so rounding can
 * never buy a paid repair call.
 */
function checkOverstatedCaps(
  plan: AdvisorPlan,
  projection: PlanProjection | undefined,
  warn: (kind: PlanWarningKind, message: string) => void,
): void {
  const tally = plan.projectedResistances;
  if (!tally || !projection) return;
  // A partial projection cannot indict the tally: a skipped verdict (a CRAFT,
  // an id that already warned as unknown) means the computed figure is missing
  // gains the model legitimately counted, and firing here would spend repair
  // calls on the projection's own gaps. The live slip this check exists for
  // projected cleanly — zero skips — and only that case is decidable.
  if (projection.skipped.length > 0) return;

  for (const row of projection.resistances) {
    const claimed = Object.entries(tally).find(([label]) => label.toLowerCase() === row.label.toLowerCase())?.[1];
    if (claimed === undefined) continue;
    const shortfall = row.capAfter - row.after;
    if (claimed >= row.capAfter && shortfall > 2) {
      warn(
        'overstated-cap',
        `the tally claims ${row.label} Resistance at ${claimed} — at or over the ${row.capAfter} cap — but applying ` +
          `the plan's own verdicts computes ${row.after} effective, ${Math.round(shortfall)} short of cap; a listed ` +
          `cost was dropped from the arithmetic — re-add it, then either cover the gap or state the shortfall as a decision`,
      );
    }
  }
}

/**
 * An empty component socket the plan walks past.
 *
 * The dossier prints **component socket: EMPTY — a free upgrade** on every
 * worn item this applies to, and `freeComponentIds` says which components cost
 * nothing to install — so a slot that ends the plan with an empty socket while
 * a free, legal component exists is a missed move, not a judgement call. This
 * is the thoroughness failure a lower reasoning effort was observed to make,
 * so it is decided mechanically rather than left to the effort knob; the
 * repair round then feeds it back like any other warning.
 *
 * The item examined is the one the slot **ends up** holding — the candidate
 * for an `EQUIP` — same rule as `checkFits`. A socket verdict on the component
 * itself and a `fits` entry both count as filling it. `CRAFT` is exempt: the
 * item is transformed, and what its sockets hold afterwards is not the
 * dossier's to know.
 */
function checkEmptySockets(
  plan: AdvisorPlan,
  input: PlanCheckInput,
  projection: PlanProjection | undefined,
  warn: (kind: PlanWarningKind, message: string) => void,
): void {
  const free = input.freeComponentIds;
  if (free?.size && input.socketablesById) {
    for (const v of plan.verdicts) {
      if (v.verdict === 'CRAFT' || v.verdict === 'ADD-COMPONENT' || v.verdict === 'SWAP-COMPONENT') continue;
      if (v.fits?.some((f) => f.kind === 'component')) continue;
      const hostId = v.verdict === 'EQUIP' ? v.target : v.itemId;
      const host = hostId ? input.itemsById.get(hostId) : undefined;
      if (!host || host.component || !acceptsComponent(host)) continue;
      const flag = slotFlagForClass(host.base?.slot);
      if (!flag) continue;

      const fitting = [...free]
        .map((id) => input.socketablesById?.get(id))
        .filter((c): c is DbItem => !!c && (!c.allowedSlots?.length || c.allowedSlots.includes(flag)));
      if (fitting.length === 0) continue;

      const names = fitting.slice(0, 3).map((c) => c.name).join(', ');
      warn(
        'unfilled-socket',
        `${v.slot} ends the plan with an empty component socket on ${host.display}, while a free component fits ` +
          `(${names}${fitting.length > 3 ? ', …' : ''}) — fill it via a component verdict or \`fits\`, or say why it stays empty`,
      );
    }
  }

  // The augment socket, the same way — but only where the plan's own
  // projection leaves a cappable resistance under cap and a reachable augment
  // legal on the slot raises it. An augment is bought, not free, so an empty
  // socket on a capped loadout is a choice; on an under-cap one it is the
  // cheapest lever in the prompt's own ordering, walked past. Stands down on a
  // partial projection, as `overstated-cap` does.
  const augments = input.freeAugmentIds;
  if (!augments?.size || !input.socketablesById || !projection || projection.skipped.length > 0) return;
  const short = new Map<ResistKey, { label: string; by: number }>();
  for (const row of projection.resistances) {
    const column = RESIST_COLUMNS.find((c) => c.label === row.label);
    if (!column || column.key === 'physical') continue;
    if (row.after < row.capAfter) short.set(column.key, { label: row.label, by: Math.round(row.capAfter - row.after) });
  }
  if (short.size === 0) return;
  const scalar = (value: StatValue): number => (typeof value === 'number' ? value : 0);

  for (const v of plan.verdicts) {
    if (v.verdict === 'CRAFT' || v.verdict === 'RE-AUGMENT' || v.verdict === 'BUY-AUGMENT') continue;
    if (v.fits?.some((f) => f.kind === 'augment')) continue;
    const hostId = v.verdict === 'EQUIP' ? v.target : v.itemId;
    const host = hostId ? input.itemsById.get(hostId) : undefined;
    if (!host || host.augment || !acceptsAugment(host)) continue;
    const flag = slotFlagForClass(host.base?.slot);
    if (!flag) continue;

    const fitting: { name: string; lines: string[] }[] = [];
    for (const id of augments) {
      const a = input.socketablesById.get(id);
      if (!a || (a.allowedSlots?.length && !a.allowedSlots.includes(flag))) continue;
      const lines = resistContributions(a.stats, scalar);
      const helps = [...short].filter(([key]) => (lines[key] ?? 0) > 0).map(([key, s]) => `+${lines[key]}% ${s.label} Resistance`);
      if (helps.length) fitting.push({ name: a.name, lines: helps });
    }
    if (fitting.length === 0) continue;

    const gaps = [...short.values()].map((s) => `${s.label} Resistance ${s.by} under cap`).join(', ');
    const named = fitting.slice(0, 3).map((f) => `${f.name} (${f.lines.join(', ')})`).join(', ');
    warn(
      'unfilled-socket',
      `${v.slot} ends the plan with an empty augment socket on ${host.display} while the plan leaves ${gaps}, and a ` +
        `reachable augment raises it (${named}${fitting.length > 3 ? ', …' : ''}) — fill it via BUY-AUGMENT or \`fits\`, or say why it stays empty`,
    );
  }
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

/**
 * The socketables a verdict tells the slot to fit, beyond the one it is named
 * for.
 *
 * Same three questions as `checkSocket` — does the id resolve, does the name
 * agree with it, will the item accept it — with one difference that is the whole
 * reason this is separate: the **host is the item the slot ends up holding**.
 * For an `EQUIP` that is the candidate, so a fit is legal or illegal according to
 * the incoming item's class; running it against the outgoing item would clear a
 * component for gear the plan is telling you to take off.
 *
 * A fourth question is only askable here: `kind` is asserted rather than derived,
 * so a plan can claim an augment is a component. The two go in independent
 * sockets, so getting it wrong means the window renders the fit into the wrong
 * one — silently, since both sockets exist on every item.
 */
function checkFits(
  v: AdvisorPlan['verdicts'][number],
  input: PlanCheckInput,
  warn: (kind: PlanWarningKind, message: string) => void,
): void {
  if (!v.fits?.length) return;
  const where = `${v.verdict} on ${v.slot}`;
  // The item that will be wearing them. An `EQUIP`'s `target` is an item id;
  // every other verdict keeps what is in the slot.
  const hostId = v.verdict === 'EQUIP' ? v.target : v.itemId;
  const host = hostId ? input.itemsById.get(hostId) : undefined;
  const flag = slotFlagForClass(host?.base?.slot);

  const seen = new Set<string>();
  for (const fit of v.fits) {
    const part = fit.id ? input.socketablesById?.get(fit.id) : undefined;
    if (!part) {
      warn(
        'unknown-socketable',
        `${where} fits \`#${fit.id}\`, which is not a component or augment id in the document`,
      );
      continue;
    }
    if (fit.name && !namesAgree(fit.name, part.name)) {
      warn('name-mismatch', `${where} fits "${fit.name}" but \`#${fit.id}\` is ${part.name}`);
    }
    // One component and one augment, in independent sockets. Two of either is
    // not a legal item state, and the second would silently overwrite the first.
    if (seen.has(fit.kind)) {
      warn('illegal-socket', `${where} fits two ${fit.kind}s — an item holds one`);
    }
    seen.add(fit.kind);
    if (flag && part.allowedSlots?.length && !part.allowedSlots.includes(flag)) {
      warn(
        'illegal-socket',
        `${part.name} cannot go on ${host?.display ?? v.slot} — its use-on restriction does not accept ${flag}`,
      );
    }
  }
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
