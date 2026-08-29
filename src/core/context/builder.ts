/**
 * The context document: everything the tool knows about one character, compiled
 * into a single markdown file an LLM can reason from.
 *
 * The design bar is **self-containment**. The advisor gets this document and
 * nothing else — no game, no web, and no reliance on its own memory of Grim
 * Dawn, which may predate v1.3 and Fangs of Asterkarn. So §2 states the rules
 * (resistance caps, the per-resistance difficulty penalty, socket and salvage
 * economics, conversion order, speed caps, respec costs) rather than assuming
 * them, and every number below it is attributed to the source that produced it.
 *
 * Markdown, not JSON: `+18% Chaos Resistance` costs a third of what
 * `{"defensiveChaos": 18}` does, and the file doubles as something the user can
 * read. Rendering only — every game mechanic was computed in `src/core/mechanics`.
 */

import type { DbItem, DbRecipe, DbSet, DbSkill, GameDb, RepTier, StatValue } from '@grimdawn/core/db/types';
import { REP_TIERS } from '@grimdawn/core/db/types';
import type { CharacterAggregate, DualWieldEnabler, MatrixRow } from '../mechanics/aggregate.js';
import type { CharacterStanding, RequirementCheck, RequirementGap } from '../mechanics/requirements.js';
import { atRank, classify, modifierParent, skillLabel, statRecord, type EffectiveRank } from '../mechanics/skills.js';
import {
  addAttributes,
  addDamage,
  addSpeed,
  ATTR_KEYS,
  collectResistReduction,
  DAMAGE_TYPES,
  emptyAttributes,
  emptyDamage,
  emptySpeed,
  ARMOR_PARTS,
  resistContributions,
  RESIST_COLUMNS,
  type AttrKey,
  type DamageKey,
  type ResistKey,
  type ResistReductionRow,
  type ResistVector,
} from '../mechanics/stats.js';
import { shortHash, type AccountFiles, type ResolvedCharacter, type ResolvedItem } from '@grimdawn/core/resolve';
import { candidateProjections, type CandidateProjection, type SlotProjection } from './projections.js';
import type { AugmentOption, ClosableWitness } from './closable.js';
import { factionSlot, factionTier } from '@grimdawn/core/save/factions';
import { EQUIP_SLOT_NAMES, type CharacterSave } from '@grimdawn/core/save/types';
import {
  equipGroup,
  estimateTokens,
  EQUIP_GROUPS,
  itemStatBlocks,
  LEVEL_WINDOW,
  selectCandidates,
  type Candidate,
  type CandidateSelection,
  type EquipGroup,
} from './filters.js';
import { describeSlots, formatStats, num, signed } from './statfmt.js';

export interface ContextInput {
  save: CharacterSave;
  /** Aggregates for the difficulty the document is being written for. */
  aggregate: CharacterAggregate;
  /** Everything the character can reach, plus the account's blueprints. */
  resolved: ResolvedCharacter;
  db: GameDb;
  /**
   * The account-wide files as parsed. Optional because the resolved items
   * already carry everything they hold; a candidate projection needs it only
   * to find a transfer-stash item's saved instance, and degrades to "not
   * projected" without it.
   */
  account?: AccountFiles | undefined;
}

export interface ContextOptions {
  /** Token ceiling; the builder tightens candidate caps until it fits. */
  maxTokens?: number;
  /** Candidates per equipment group before tightening. */
  perGroup?: number;
  /**
   * Project every §7 candidate against the worn loadout and print the delta
   * under it (see `projections.ts`). Off by default: it costs one aggregate
   * per candidate, and the snapshot built on every watcher tick only feeds ids
   * to the window — `adviceScope` turns it on for the document the model reads.
   */
  projections?: boolean;
}

/**
 * The default budget is a **safety net, not a target**.
 *
 * The document's real size is bounded by the level window in `filters.ts`, not
 * by this number: everything a normally-stocked character can reach comes to
 * roughly 36k tokens, and no budget above that changes the file at all. What
 * the headroom buys is the hoarder case — a transfer stash five times the size
 * of the test character's — where the per-slot cap would otherwise start
 * discarding real candidates to hit a number nobody is paying for. Trimming a
 * candidate is a genuine loss of information, so it should happen only when the
 * prompt would actually be too large to reason over, and the receiving model
 * here has a 1M-token window.
 */
export const DEFAULT_MAX_TOKENS = 100_000;

/**
 * Candidates per slot before any trimming. High enough to be no constraint on
 * an ordinary stash — the level window has already done the filtering — while
 * still bounding the pathological case.
 */
export const DEFAULT_PER_GROUP = 40;

export interface ContextDoc {
  markdown: string;
  tokenEstimate: number;
  /** What the token gate gave up to fit, in the order it gave it up. */
  trimmed: string[];
  /** Item id → display name, for callers that need to resolve the advisor's output. */
  itemIds: Map<string, string>;
  /**
   * The same index, but to the item itself — what Stage 6 checks the advisor's
   * plan against (an id that is not here was hallucinated) and what Stage 7
   * highlights on the grid.
   */
  itemsById: Map<string, ResolvedItem>;
  /**
   * Every component and augment the document offered, by the id it printed.
   * Stage 6's checks resolve a socket target through this — an id that is not
   * here was not on the table, whatever the game's own database contains.
   */
  socketablesById: Map<string, DbItem>;
  /**
   * The gear the document actually put in front of the model: everything §7
   * ranked, plus the carried-but-unranked line at its foot. The coverage check
   * measures a plan against this — an item the document never showed cannot be
   * demanded a verdict on, and one it did show must not simply be ignored.
   */
  candidateIds: Set<string>;
  /**
   * Components that cost nothing to install: a loose copy on hand, or a
   * learned blueprint craftable right now — the two origins §8's census calls
   * free. The empty-socket check runs against this set; a component whose only
   * copy is installed in gear is deliberately absent, because extracting it
   * destroys the host and proposing that is a judgement call, not a free fill.
   */
  freeComponentIds: Set<string>;
  /**
   * Augments that can be had: loose on hand, or in the faction stock at a
   * tier the character has reached — §9's list plus §8's loose ones, by
   * dossier id. What the empty-augment check reads; bought rather than free,
   * so the check fires only where the plan leaves a resistance under cap.
   */
  freeAugmentIds: Set<string>;
  /**
   * The projected swap under each §7 candidate, by dossier id. Empty unless
   * `ContextOptions.projections` asked for them (or the token gate gave them
   * up — `trimmed` says so).
   */
  projections: Map<string, CandidateProjection>;
}

/**
 * Candidate caps the token gate steps down through when a document really is
 * too big. Entries at or above the starting cap are skipped, so an explicit
 * `--candidates 5` never widens back out to 12.
 */
const CAP_LADDER = [12, 8, 5, 3];

export function buildContextDoc(input: ContextInput, opts: ContextOptions = {}): ContextDoc {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const startCap = opts.perGroup ?? DEFAULT_PER_GROUP;

  // Progressive tightening, cheapest loss first. The matrix, the skills and the
  // equipped blocks are never touched — they are the parts a swap is judged on.
  const tightest = CAP_LADDER[CAP_LADDER.length - 1] ?? 3;
  const projections = opts.projections ?? false;
  const ladder: Trim[] = [
    // A projection is derivable from the rest of the document; a dropped
    // candidate is not. So the projections go first, before any candidate does.
    ...(projections ? [{ perGroup: startCap, projections: false, note: 'candidate projections omitted' }] : []),
    ...CAP_LADDER.filter((cap) => cap < startCap).map((cap) => ({
      perGroup: cap,
      note: `candidates capped at ${cap} per slot`,
    })),
    { perGroup: tightest, compressRecipes: true, note: 'blueprint section compressed to counts' },
    { perGroup: tightest, compressRecipes: true, compressCensus: true, note: 'component census compressed to counts' },
    {
      perGroup: tightest,
      compressRecipes: true,
      compressCensus: true,
      dropRankTables: true,
      note: 'rank-by-rank skill tables omitted',
    },
  ];

  const trimmed: string[] = [];
  // Projections are computed once and shared across the trim rungs — a rung
  // only ever shrinks the candidate set, so nothing new is ever needed.
  const projectionCache = new Map<ResolvedItem, CandidateProjection>();
  let doc = render(input, { perGroup: startCap, projections, note: 'nothing trimmed' }, projectionCache);
  for (const step of ladder) {
    if (estimateTokens(doc.text) <= maxTokens) break;
    doc = render(input, step, projectionCache);
    trimmed.push(step.note);
  }

  const itemsById = idIndex(input.resolved.items);
  const socketables = documentSocketables(input);
  const socketableIds = assignSocketableIds(socketables, new Set(itemsById.keys()));
  const byRecord = new Map(socketables.map((item) => [item.record, item]));
  const socketablesById = new Map<string, DbItem>();
  for (const [record, id] of socketableIds) {
    const item = byRecord.get(record);
    if (item) socketablesById.set(id, item);
  }

  return {
    markdown: doc.text,
    tokenEstimate: estimateTokens(doc.text),
    trimmed,
    itemIds: new Map([...itemsById].map(([id, item]) => [id, item.display])),
    itemsById,
    socketablesById,
    candidateIds: doc.candidateIds,
    freeComponentIds: doc.freeComponentIds,
    freeAugmentIds: doc.freeAugmentIds,
    projections: doc.projections,
  };
}

interface Trim {
  perGroup: number;
  /** Print the projected swap under each candidate. */
  projections?: boolean;
  compressRecipes?: boolean;
  compressCensus?: boolean;
  /** Last resort: §4's rank-by-rank skill tables go, with a line saying so. */
  dropRankTables?: boolean;
  /** What this step gives up, for the caller to report. */
  note: string;
}

// ---------------------------------------------------------------------------
// Item ids
// ---------------------------------------------------------------------------

/**
 * `ResolvedItem.id` is a hash of the saved instance, so two genuinely identical
 * stacked items share one. Disambiguating with a letter here keeps every id in
 * the document unique, which is what the advisor's per-item recommendations and
 * the UI's highlighting both depend on.
 */
function assignIds(items: readonly ResolvedItem[]): Map<ResolvedItem, string> {
  const out = new Map<ResolvedItem, string>();
  const seen = new Map<string, number>();
  for (const item of items) {
    const n = seen.get(item.id) ?? 0;
    seen.set(item.id, n + 1);
    out.set(item, n === 0 ? item.id : `${item.id}${String.fromCharCode(96 + n)}`);
  }
  return out;
}

function idIndex(items: readonly ResolvedItem[]): Map<string, ResolvedItem> {
  const ids = assignIds(items);
  return new Map([...ids].map(([item, id]) => [id, item]));
}

/**
 * Ids for components and augments, from the same alphabet as item ids.
 *
 * Until now these were referenced by *name* while everything else was referenced
 * by id, which is why `verify.ts` carries two normalizers and a
 * strip-the-parenthetical fallback to decide whether "Dread Skull (loose)" is a
 * component the document offered. A socketable has no save instance, so its
 * identity is its record path — hash that, and the fuzzy match goes away.
 *
 * `reserved` holds the item ids already handed out, because the two id spaces
 * share one namespace: the model is told "identify everything by its id", and it
 * would be a poor joke if two different things could answer to one.
 */
function assignSocketableIds(items: readonly DbItem[], reserved: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set(reserved);
  for (const item of [...items].sort((a, b) => a.record.localeCompare(b.record))) {
    let id = shortHash(item.record);
    for (let n = 1; used.has(id); n++) id = shortHash(`${item.record}#${n}`);
    used.add(id);
    out.set(item.record, id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

function render(
  input: ContextInput,
  trim: Trim,
  projectionCache: Map<ResolvedItem, CandidateProjection>,
): {
  text: string;
  candidateIds: Set<string>;
  freeComponentIds: Set<string>;
  freeAugmentIds: Set<string>;
  projections: Map<string, CandidateProjection>;
} {
  const { save, resolved } = input;
  const ids = assignIds(resolved.items);
  const out = new Writer();

  const equipped = resolved.items.filter((i) => i.source === 'equipped');
  const invested = new Set(save.skills.filter((s) => s.level > 0).map((s) => s.record));
  const recipes = recipeView(input);
  const socketableIds = assignSocketableIds(documentSocketables(input, recipes), new Set(ids.values()));
  const ctx: RenderContext = {
    ...input,
    ids,
    socketableIds,
    projections: trim.projections ? projectionCache : new Map(),
    equipped,
    invested,
    ranks: new Map(input.aggregate.ranks.map((r) => [r.record, r])),
    recipes,
    iron: ironOutlook(input, recipes),
  };

  header(out, ctx);
  gameRules(out, ctx);
  attributesAndDefenses(out, ctx);
  buildProfile(out, ctx, trim);
  equippedSection(out, ctx);
  const selection = candidateSelection(ctx, trim.perGroup);
  const fodder = bagFodder(ctx, selection);
  const components = componentCensus(ctx, selection);
  const augments = augmentCensus(ctx);
  if (trim.projections) {
    const pending = [...selection.byGroup.values()].flat().filter((c) => !projectionCache.has(c.item));
    if (pending.length) {
      const computed = candidateProjections(pending, {
        save,
        account: input.account,
        db: input.db,
        aggregate: input.aggregate,
        resolved,
        ids,
        obtain: socketableObtain(input, recipes),
        socketableIds: ctx.socketableIds,
        freeComponents: freeComponentSources(components),
        augments: augmentUniverse(ctx, augments),
      });
      for (const [item, projection] of computed) projectionCache.set(item, projection);
    }
  }
  setStatus(out, ctx);
  candidatesSection(out, ctx, selection, fodder, components, augments);
  census(out, ctx, components, augments, trim);
  factionAugments(out, ctx);
  blueprints(out, ctx, selection, trim);
  task(out, ctx);
  unlockLadder(out, ctx, selection);

  // What §7 put in front of the model, ranked and unranked alike — the set the
  // coverage check holds a plan's dispositions against.
  const candidateIds = new Set<string>();
  for (const list of selection.byGroup.values()) {
    for (const c of list) {
      const id = ctx.ids.get(c.item);
      if (id) candidateIds.add(id);
    }
  }
  for (const f of fodder) {
    const id = ctx.ids.get(f.item);
    if (id) candidateIds.add(id);
  }

  // The free half of the census, by dossier id — what the empty-socket check
  // measures a plan against. Availability, so trimming never changes it.
  const freeComponentIds = new Set<string>();
  for (const e of components.values()) {
    if (e.loose.size > 0 || (e.craft && e.craft.plan.missing.length === 0)) {
      freeComponentIds.add(socketableId(ctx, e.item));
    }
  }
  const freeAugmentIds = new Set<string>();
  for (const a of augmentUniverse(ctx, augments)) freeAugmentIds.add(socketableId(ctx, a.item));

  const projections = new Map<string, CandidateProjection>();
  if (trim.projections) {
    for (const list of selection.byGroup.values()) {
      for (const c of list) {
        const id = ctx.ids.get(c.item);
        const projection = projectionCache.get(c.item);
        if (id && projection) projections.set(id, projection);
      }
    }
  }

  return { text: out.toString(), candidateIds, freeComponentIds, freeAugmentIds, projections };
}

interface RenderContext extends ContextInput {
  ids: Map<ResolvedItem, string>;
  /** Projected swaps by candidate — empty when this render prints none. */
  projections: ReadonlyMap<ResolvedItem, CandidateProjection>;
  /** Component/augment record path → its dossier id. */
  socketableIds: Map<string, string>;
  equipped: ResolvedItem[];
  /** Skill records with at least one invested point. */
  invested: Set<string>;
  /**
   * Current effective rank per invested skill, for turning a candidate's
   * `+N to <skill>` into the ranks (and numbers) it would actually buy.
   */
  ranks: ReadonlyMap<string, EffectiveRank>;
  /** §10's blueprint scope, computed once because §2 prices against it too. */
  recipes: RecipeView;
  /** Whether iron is actually scarce for this character — see `ironOutlook`. */
  iron: IronOutlook;
}

/** Accumulates markdown lines; nothing more than a joined array with helpers. */
class Writer {
  private readonly lines: string[] = [];

  line(text = ''): void {
    this.lines.push(text);
  }

  h(level: number, text: string): void {
    if (this.lines.length) this.line();
    this.line(`${'#'.repeat(level)} ${text}`);
    this.line();
  }

  bullets(items: readonly string[], indent = ''): void {
    for (const item of items) this.line(`${indent}- ${item}`);
  }

  table(headers: readonly string[], rows: readonly (readonly string[])[]): void {
    this.line(`| ${headers.join(' | ')} |`);
    this.line(`|${headers.map(() => '---').join('|')}|`);
    for (const row of rows) this.line(`| ${row.join(' | ')} |`);
  }

  toString(): string {
    return `${this.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
  }
}

// ---------------------------------------------------------------------------
// 1 — header
// ---------------------------------------------------------------------------

function header(out: Writer, ctx: RenderContext): void {
  const { save, aggregate, db } = ctx;
  const className = db.localize(save.classRecord);
  const masteries = save.skills
    .map((s) => db.getSkill(s.record))
    .filter((s): s is DbSkill => s?.class === 'Skill_Mastery')
    .map((s) => skillLabel(s, db));

  out.h(1, `${save.name} — level ${save.level} ${className === save.classRecord ? masteries.join('/') : className}`);
  out.bullets([
    `masteries: ${masteries.join(' + ') || 'none'}`,
    `difficulty: **${aggregate.difficulty}** (currently playing ${save.difficulty}; greatest completed ${save.greatestDifficultyCompleted})`,
    `hardcore: ${save.hardcore ? 'yes — a death is permanent, favour survivability' : 'no'}`,
    `iron on hand: ${save.iron.toLocaleString('en-US')}`,
    `holding weapon set ${aggregate.weaponSet}; ${aggregate.wielding.mode}`,
    `game version: ${db.gameVersion} (this document is generated from the installed game data, not a published dump)`,
  ]);
}

// ---------------------------------------------------------------------------
// 2 — game rules
// ---------------------------------------------------------------------------

/** Slots that take an augment — the twelve worn pieces plus the held weapons. */
const AUGMENTABLE_SLOTS = 12;

/**
 * Iron only stops being a constraint by this factor of the worst plausible
 * shopping bill. Below it the advisor should still budget; the point is not to
 * declare iron free, it is to stop a character with 37× the whole spend from
 * getting a budget section.
 */
const IRON_COMFORT_FACTOR = 5;

interface IronOutlook {
  onHand: number;
  /** Worst case for the routine spend: the priciest augment in every augmentable slot. */
  bill: number;
  worstAugment: number;
  /**
   * The priciest craft in §10's scope, reported *beside* the bill rather than
   * inside it. A single 250,000 relic craft is a deliberate, one-off decision —
   * folding it into the routine bill would declare a millionaire "constrained"
   * over a purchase they would weigh on its own merits anyway. The advisor is
   * told to quote a genuinely large price; that clause is what covers this.
   */
  worstCraft: number;
  /** False when iron is comfortably above the bill — then no budgeting is asked for. */
  constrained: boolean;
}

/**
 * Whether iron is worth reasoning about for this character.
 *
 * The first live run spent a whole section and four running totals on 35,500
 * against 1,315,676 — arithmetic that could not change any decision. Blanket
 * removal is wrong too: iron is genuinely scarce early, and Ascension's 250,000
 * is real money at any level. So the document *computes* the answer against a
 * worst-case bill and states which regime the character is in, and the prompt's
 * "respect the iron" clauses hang off that statement.
 */
function ironOutlook(input: ContextInput, recipes: RecipeView): IronOutlook {
  const { save, db, aggregate } = input;
  const price = (item: DbItem): number => {
    const cost = item.stats['itemCost'];
    return typeof cost === 'number' ? cost : 0;
  };
  const worstAugment = Math.max(
    0,
    ...vendorStock(save, db, aggregate.level).flatMap((g) => g.augments.map(price)),
  );
  const worstCraft = Math.max(0, ...recipes.relevant.map((r) => recipes.planFor(r).ironTotal));
  const bill = worstAugment * AUGMENTABLE_SLOTS;
  return {
    onHand: save.iron,
    bill,
    worstAugment,
    worstCraft,
    constrained: bill > 0 && save.iron < bill * IRON_COMFORT_FACTOR,
  };
}

/**
 * Overcap is an endgame target, not a levelling one: enemy resistance
 * reduction is what it buys against, and gear before ~94 turns over too fast
 * for deliberate overcap to pay. 94 is when endgame gear goes on and stays on.
 */
const OVERCAP_ENDGAME_LEVEL = 94;

/** Whether §2 states the +20–30 overcap target, or "the cap itself". */
function overcapEndgame(ctx: RenderContext): boolean {
  return ctx.aggregate.difficulty === 'Ultimate' && ctx.save.level >= OVERCAP_ENDGAME_LEVEL;
}

function gameRules(out: Writer, ctx: RenderContext): void {
  const { aggregate, db } = ctx;
  const caps = db.speedCaps();
  const penalty = RESIST_COLUMNS.map((c) => `${c.label} ${num(aggregate.resistances.penalty[c.key] ?? 0)}`).join(' · ');

  out.h(2, '2. Game rules (v1.3, Fangs of Asterkarn — do not substitute older knowledge)');

  out.line('**Resistances.** Each of the ten damage resistances caps at 80%. `+% Maximum X Resistance` raises that cap, to a hard ceiling of 95%. The difficulty penalty is subtracted from the total *before* the cap, and it is **not uniform** — the in-game "−25%/−50% to all resistances" blurb is a simplification. On this character\'s difficulty the penalty **to each resistance** is:');
  out.line();
  out.line(`> ${aggregate.difficulty}: ${penalty}`);
  out.line();
  out.line(
    overcapEndgame(ctx)
      ? 'Enemies in the late game carry resistance reduction of their own, so at this character\'s stage the community target is **+20 to +30 overcap** on the resistances a build actually faces, not exactly 80. Being under cap on a resistance the character meets constantly is the single most common cause of death.'
      : 'Enemies in the late game carry resistance reduction of their own, and at level 94+ on Ultimate the community therefore targets +20 to +30 over cap — but this character is not there yet, so **the overcap target is the cap itself**: overcap picked up along the way is welcome buffer, never something to trade damage, health or an under-cap resistance for, because gear turns over too fast before endgame Ultimate for deliberate overcap to pay. Being under cap on a resistance the character meets constantly is the single most common cause of death.',
  );

  out.line();
  out.line(
    '**Physical Resistance is the exception, and the cap rule does not apply to it.** It is the scarcest resistance in the game — it appears on some armour, shields and a few devotions, and on no augment — so no realistic loadout caps it, and the community treats 20–30% as a good figure rather than a deficit (the difficulty penalty above does not touch it either). Treat whatever the character has as a bonus defensive layer: its under-cap figure is never a shortfall to fix, and a few points of Physical Resistance never outweigh on-build damage, Offensive Ability or a cappable resistance still under its target.',
  );

  out.line();
  const hits = ctx.db.combatFormulas().hitChances;
  out.line(`**Armour is localized, not pooled.** Every physical hit rolls one body part — ${ARMOR_PARTS.map((p) => `${p.slot} ${num(hits[p.slot] ?? p.hitChance)}%`).join(', ')} (the game's own combat formulas record) — and is met by *that piece alone*. Summing six ratings describes a character who does not exist. Flat \`+Armor\` from rings, components and skills is added to **every** part. Absorption is multiplicative on a 70% base: \`+20% Armor Absorption\` gives 84%, not 90%, and it caps at 100%.`);

  out.line();
  out.line(
    '**Attack damage converted to health is sustain, and what it applies to depends on where it sits.** Community-established mechanics, not game data: a *global* `% of Attack Damage converted to Health` — from gear, components, augments, passives and devotions; §3 states the total and names every source — heals for that share of the damage dealt by weapon attacks and by the `% Weapon Damage` portion of a skill, so its worth is set by how much of the build\'s damage is weapon damage (§4\'s weapon-attack composition and each skill\'s `% weapon damage` say). A skill\'s *own* figure (§4 marks it *this skill only*) applies to that skill\'s whole damage. Damage over time and retaliation never leech. The heal is reduced by the **target\'s** Life Leech Resistance — a different thing from the character\'s own `Life Leech` entry among §3\'s other resistances, which is protection against *being* leeched.',
  );

  out.line();
  out.line(
    `**Speed caps** (engine values): attack ${caps.attack}%, cast ${caps.cast}%, movement ${caps.run}%. \`+% speed\` past a cap is worth nothing — never trade a real stat for it on a build already at cap. ` +
      '**Attack speed is a multiplier on all damage throughput**, so it is not a minor stat below the cap and not a stat at all above it. ' +
      'It works like this: the character has a base rate in attacks per second, a weapon shifts that base by its own **additive delta in attacks/second** (never a percentage — a "Very Fast" weapon is about −0.02, "Very Slow" about −0.20), ' +
      'and the character-sheet percentage is the resulting rate over the unarmed baseline, with the cap applied to *that*. ' +
      'Two consequences the numbers in §3 already work out: a slower weapon starts further below 100% and so needs materially more `+% Attack Speed` to reach the same cap, ' +
      'and a character already at the cap loses nothing by giving up speed down to it. **§3 states this character\'s three speeds, the cap and the remaining headroom — read them there rather than estimating.**',
  );

  out.line();
  out.line('**Granted skills.** Wherever an item, component or augment reads `Grants: <skill>`, the skill\'s own stats follow it and the parenthetical says **how you get them**: `passive — always on` (simply true), `toggle` (true while held, at the energy reservation shown in its stats), `activated` (you have to cast it), `auto-cast <trigger>` (a proc — a chance per trigger, not a constant), or `weapon-pool proc` (a share of basic attacks). **Whether it is summed follows its kind, because the kind is what says when it applies:** a `passive` and a `toggle` are on, so their stats *are* counted in §3 and §4, on their own attributable row named for the skill (a toggle\'s row states the energy it reserves, which is the one reason to discount it). An `activated`, `auto-cast`, `weapon-pool proc` or pet skill is **not** summed — it is conditional, and §3 lists it as an exclusion — but it is named and shown so you can weigh it yourself.');

  out.line();
  out.line('**Sockets.** An item holds up to **one component** and **one augment**, in independent sockets.');
  out.bullets([
    'Every component and augment carries a use-on restriction (listed with it below). It may only be proposed for gear that restriction accepts.',
    'Applying a loose socketable to an **empty** socket is free and instant.',
    'Augments are consumables bought from faction vendors with iron. Removing one **destroys** it — it is never recovered — so replacing an augment costs only the price of the new one. Treat every augment slot as a free variable.',
    'Applying an augment **soulbinds** the item: it cannot be traded or placed in the transfer stash until the augment is removed (which destroys the augment).',
    "An occupied **component** socket goes through the Inventor's salvage, which is either/or with an iron fee: **keep the item → the installed component is destroyed** (and any augment with it), or **keep the component → the host item is destroyed** (and its augment). So upgrading a kept item's component costs the old component + fee + a fresh augment, and moving a single-instance component to new gear costs the old item.",
    'Partial components no longer exist in the game — a component is always whole.',
    'A component that grants a buff grants it **per copy**: two weapons with the same component give two instances of the buff, and their stats add. This is the one case where a duplicate socketable is worth more than the first — unlike set pieces, which count distinct members only.',
  ]);

  out.line();
  ironRule(out, ctx);

  out.line();
  const lp = db.levelProgression();
  const perPoint = new Set(Object.values(lp.attributePerPoint));
  out.line('**Requirements.** Items demand a character level and Physique/Cunning/Spirit.');
  out.bullets([
    '`-% Requirement` reductions stack additively and are scoped by gear family (Armor, Jewelry, Shield, Weapon, Melee, Hunting), with Global stacking on top of the scope.',
    'A reduction or a `+Attribute` granted by an item **vanishes when that item is swapped out**, so any joint move has to be re-checked against the post-swap loadout.',
    perPoint.size === 1
      ? `One unspent attribute point = ${[...perPoint][0]} points of any one attribute, and each character level grants ${lp.attributePointsPerLevel} attribute point(s). (Both read from the game's own level table, not assumed.)`
      : `One unspent attribute point = ${lp.attributePerPoint.physique} Physique / ${lp.attributePerPoint.cunning} Cunning / ${lp.attributePerPoint.spirit} Spirit, and each level grants ${lp.attributePointsPerLevel} point(s).`,
    'A deficit that levelling or unspent points will close is a **HOLD-until**, never a reject — §12 does that arithmetic.',
  ]);

  out.line();
  out.line('**Dual wielding requires an enabler, and the two kinds are not interchangeable:**');
  out.bullets([
    '**Permanent** — an invested mastery passive (Dual Blades, Implements of War). These are spent skill points: they survive *every* gear change, so while one exists no swap can end dual wielding, and an item must never be kept "for the dual-wield grant".',
    "**Gear-granted** — an item-granted skill (Direwolf Claw, Mutilate, Bloodbath, Gunslinger's Talent). These leave with the item.",
    'A swap that removes the *last* enabler of **either** kind while leaving two one-handers is illegal, not merely weak. §4 states which kinds this character has.',
  ]);

  out.line();
  out.line('**Respec economy.** Skill points refund at the Spirit Guide for iron (the cost rises per point and caps at 15,000), and the mastery bar can be lowered — but the **class combination is permanent**. Attribute points refund only via the Tonic of Reshaping, which is scarce (two from quests, then craftable at hidden Celestial Blacksmiths on Elite and Ultimate), so an attribute respec is a build decision worth flagging for an exceptional item and never a routine move.');

  out.line();
  out.line('**Damage conversion** (order matters, and the profile below has already applied it to its own figures):');
  out.bullets([
    "A skill's own conversion (its record, its modifiers, its transmuter) applies **first**, and only to that skill.",
    'Then global conversion from equipment and permanently active buffs.',
    '`+% damage` modifiers apply **after** conversion, to the **output** type — a converted build wants modifiers of the type it ends up dealing, not the type it started from.',
    'Damage is converted **once only**; it never chains through a second pair. One in-type drawn past 100% splits the pool proportionally.',
    'A converting type takes its damage-over-time twin with it: Physical↔Internal Trauma, Fire↔Burn, Cold↔Frostburn, Lightning↔Electrocute, Acid↔Poison, Vitality↔Vitality Decay. Pierce, Aether and Chaos have **no twin**, so their DoT part stays behind unconverted. **Bleeding never converts at all.**',
    '`Elemental` as an in-type converts Fire, Cold *and* Lightning each at the stated %; as an out-type it splits evenly three ways. Flat Elemental damage is a third of each element, and `+% Elemental` boosts all three (but not their DoTs).',
    '**`% Armor Piercing` on a weapon is implicit conversion**: that share of the weapon\'s *physical* damage is dealt as Pierce instead. Physical only, and only the base weapon record\'s own ratio.',
    '**Flat damage on gear only reaches weapon attacks** — the default attack and any skill with a `% Weapon Damage` component. It does not raise a skill that has none. The weapon-attack composition below is what those flats describe.',
    "A candidate's own conversion can *be* its damage-type fit: a 100%-physical→pierce gun is a pierce weapon.",
  ]);

  out.line();
  out.line(`**Faction vendors.** Market tiers unlock at Friendly ≥1,501, Respected ≥5,001, Honored ≥10,001, Revered ≥25,000 reputation. ("Trusted" is a reputation level in game but *not* a market tier.) Only the tiers this character has actually reached are listed in §9, with each augment's iron price.`);
}

/** Whether iron is a real constraint here, stated as a rule the advisor follows. */
function ironRule(out: Writer, ctx: RenderContext): void {
  const iron = ctx.iron;
  const money = (n: number): string => n.toLocaleString('en-US');
  const bill = `a worst-case ~${money(iron.bill)} — the priciest augment available (${money(iron.worstAugment)}) in all ${AUGMENTABLE_SLOTS} augmentable slots, plus the priciest craft in §10 (${money(iron.worstCraft)})`;

  if (iron.constrained) {
    out.line(
      `**Iron is a constraint for this character**: ${money(iron.onHand)} on hand against ${bill}. ` +
        'Budget explicitly — quote the price of every purchase, keep a running total, and do not propose a plan that overspends.',
    );
    return;
  }
  out.line(
    `**Iron is not a constraint for this character**: ${money(iron.onHand)} on hand against ${bill}. ` +
      '**Do not compute iron totals and do not write a budget section.** Quote a price only when it is genuinely large relative to the pile — the Ascendant Altar\'s 250,000 per roll is the usual example. Prices stay listed in §9 and §10 for reference, not for arithmetic.',
  );
}

// ---------------------------------------------------------------------------
// 3 — attributes, defenses, resistance matrix
// ---------------------------------------------------------------------------

function attributesAndDefenses(out: Writer, ctx: RenderContext): void {
  const { aggregate, save } = ctx;
  const a = aggregate.attributes;

  out.h(2, '3. Attributes and defences');

  const attrRows = ATTR_KEYS.map((key) => {
    const t = a[key];
    return [
      key,
      num(t.base),
      t.flat ? signed(t.flat) : '·',
      t.percent ? `${signed(t.percent)}%` : '·',
      `**${Math.round(t.total)}**`,
    ];
  });
  out.table(['attribute', 'base (save)', 'gear/skills', '%', 'total'], attrRows);
  out.line();
  out.bullets([
    `health ${save.attributes.health.toLocaleString('en-US')}, energy ${save.attributes.energy.toLocaleString('en-US')}`,
    `unspent: ${a.unspentPoints} attribute point(s) (see §2 for what one buys), ${save.attributes.skillPoints} skill point(s), ${save.attributes.devotionPoints} devotion point(s)`,
    `Offensive Ability contributions ${signed(a.offensiveAbility.flat)}${a.offensiveAbility.percent ? `, ${signed(a.offensiveAbility.percent)}%` : ''} — gear and skills only; the engine's level- and attribute-derived base is not modelled here`,
    `Defensive Ability contributions ${signed(a.defensiveAbility.flat)}${a.defensiveAbility.percent ? `, ${signed(a.defensiveAbility.percent)}%` : ''} — same caveat`,
  ]);

  const reductions = aggregate.requirementReductions;
  if (reductions.rows.length || reductions.levelFlat) {
    out.line();
    out.line('**Requirement reductions currently carried** (they leave with the item that grants them):');
    out.bullets([
      ...reductions.rows.map(
        (row) => `-${num(row.percent)}% ${row.attr ?? 'all attribute'} requirement on ${row.scope} — from ${row.source}`,
      ),
      ...(reductions.levelFlat ? [`-${num(reductions.levelFlat)} level requirement on every item`] : []),
    ]);
  }

  attributeScaling(out, ctx);
  defenseBlock(out, ctx);
  speedBlock(out, ctx);
  resistanceMatrix(out, ctx);
}

/**
 * What the three attributes buy beyond wearing gear — with the game's own
 * rates.
 *
 * Stated because §4's damage profile does *not* include it, and an advisor with
 * no note here has two bad options: ignore a real term, or invent a coefficient.
 * The types come from the game's attribute descriptions
 * (`tagCharAttributeDescription01`/`02`/`03`); the *rates* come from the combat
 * manager's equation strings (`GameDb.combatFormulas()`), which overturned this
 * section's original "the rate is engine-side, refuse a number" stance. How the
 * bonus stacks is the one part the data does not spell out: per the community
 * mechanics guide it joins the same additive pool as gear's `+%` — said with
 * that attribution rather than as a data fact.
 */
function attributeScaling(out: Writer, ctx: RenderContext): void {
  const a = ctx.aggregate.attributes;
  const rates = ctx.db.combatFormulas().attributeDamage;
  const perPoint = ctx.db.levelProgression().attributePerPoint;
  const pct = (points: number, rate: number): string => `+${num(points * rate * 100)}%`;
  const cun = Math.round(a.cunning.total);
  const spi = Math.round(a.spirit.total);
  out.line();
  out.line('**What the attributes themselves scale** (rates from the game\'s combat formulas record; *not* included in §4\'s `+%` columns):');
  out.bullets([
    `**Cunning ${cun}** — currently ${pct(cun, rates.physical)} Physical Damage, ${pct(cun, rates.physical)} Pierce Damage, ${pct(cun, rates.physicalDot)} Bleeding Damage and ${pct(cun, rates.physicalDot)} Internal Trauma Damage ` +
      `(${num(rates.physical * 100 * perPoint.cunning)}% / ${num(rates.physicalDot * 100 * perPoint.cunning)}% per assigned point of ${perPoint.cunning} Cunning), plus Offensive Ability and health.`,
    `**Spirit ${spi}** — currently ${pct(spi, rates.magical)} to each magical damage type (Fire, Cold, Lightning, Acid, Vitality, Aether, Chaos) and ${pct(spi, rates.magicalDot)} to each of their damage-over-time twins ` +
      `(${num(rates.magical * 100 * perPoint.spirit)}% / ${num(rates.magicalDot * 100 * perPoint.spirit)}% per assigned point of ${perPoint.spirit} Spirit), plus energy and energy regeneration.`,
    '**Physique** — health, health regeneration, dodge and crit avoidance. **No damage scaling at all** (the combat formulas carry no strength damage equation).',
    'Per the community mechanics guide this joins the **same additive pool** as gear\'s `+% damage`. One assigned point is a few `+%` against §4\'s totals — a swap moving an attribute by tens of points is a damage argument only when the resulting shift is large against §4\'s column, or when it crosses a requirement (checked exactly, above).',
  ]);
}

function defenseBlock(out: Writer, ctx: RenderContext): void {
  const d = ctx.aggregate.defense;
  out.line();
  out.line(`**Armour**, per body part (each hit rolls exactly one; hit-weighted mean ${num(d.armorAverage)}, ${d.armorClasses.join('/') || 'no armour class'}):`);
  out.line();
  out.table(
    ['body part', '% of hits', 'worn piece', 'effective'],
    d.armorSlots.map((s) => [
      s.slot + (s === d.weakestSlot ? ' ← weakest' : ''),
      `${s.hitChance}%`,
      num(s.piece),
      num(s.effective),
    ]),
  );
  out.line();
  const bonuses = [
    d.bonusArmor ? `${signed(d.bonusArmor)} flat armour to every part` : '',
    d.armorPercent ? `${signed(d.armorPercent)}% armour` : '',
  ].filter(Boolean);
  out.bullets([
    ...(bonuses.length ? [`character-wide: ${bonuses.join(', ')}`] : []),
    `absorption ${d.absorption.toFixed(1)}% (${d.absorptionBase}% base${d.absorptionPercent ? ` × 1 + ${num(d.absorptionPercent)}%` : ', no bonuses'})`,
    ...(d.hasShield ? [`shield: ${num(d.blockChance)}% chance to block, ${num(d.blockAmount)} absorbed${d.blockAmountPercent ? ` (${signed(d.blockAmountPercent)}% blocked damage)` : ''}`] : ['no shield equipped — block numbers do not apply']),
    // Per source, like the resistance rows: a swap that removes one is then a
    // computable cost. §2 says what the figure applies to; the phrase is the
    // game's own, as the item lines print it.
    ...(d.lifeLeechPercent
      ? [
          `sustain: ${d.lifeLeechPercent.toFixed(1)}% of Attack Damage converted to Health (global — §2 says what it applies to) — from ${d.lifeLeechSources
            .map((s) => `${s.slot}: ${s.label} ${num(s.value)}%`)
            .join(', ')}`,
        ]
      : ['sustain: no `% of Attack Damage converted to Health` from any permanent source']),
    `health from gear and skills ${signed(d.health)}${d.healthPercent ? `, ${signed(d.healthPercent)}%` : ''}`,
  ]);
}

/**
 * Attack, casting and movement speed against the engine caps.
 *
 * Attack speed multiplies the entire §4 damage profile, so a dossier that ranks
 * damage and omits it ranks half the answer — and both Stage 6 live runs said in
 * as many words that they could not tell whether the character was already at
 * the cap. The model is spelled out rather than just the number, because
 * `characterBaseAttackSpeed` is the kind of field that reads as a percentage and
 * is not one, and because the weapon term is what makes the headroom figure mean
 * anything.
 */
function speedBlock(out: Writer, ctx: RenderContext): void {
  const s = ctx.aggregate.speed;
  out.line();
  out.line(
    `**Speed.** Base rates are ${s.attack.base.toFixed(2)} attacks/second, ${s.cast.base.toFixed(2)} casts/second and ${s.movement.base.toFixed(2)} movement, from the player record. ` +
      'A weapon shifts the attack rate by its own additive delta in attacks/second (Very Fast ≈ −0.02, Very Slow ≈ −0.20 — it is *not* a percentage), ' +
      'and the percentage below is the resulting rate over that baseline, which is why a slow weapon starts under 100% and needs more `+% Attack Speed` to reach the same cap. ' +
      '`+% Total Speed` moves all three lines at once.',
  );
  out.line();
  out.table(
    ['speed', 'base rate', '+% permanent', '+% maintainable', 'now', 'with buffs', 'cap', 'headroom'],
    [s.attack, s.cast, s.movement].map((line) => {
      const over = line.rawPercentWithMaintainable - line.cap;
      // Attacks and casts are per second; movement is a rate in the engine's own
      // units, so quoting it "/s" would invent a unit the game never states.
      const unit = line === s.movement ? '' : '/s';
      return [
        line.label,
        `${line.weaponBase.toFixed(2)}${unit}`,
        signed(Math.round(line.permanentPercent)) + '%',
        line.maintainablePercent ? `${signed(Math.round(line.maintainablePercent))}%` : '·',
        `${Math.round(line.percent)}% (${line.rate.toFixed(2)}${unit})`,
        `${Math.round(line.percentWithMaintainable)}% (${line.rateWithMaintainable.toFixed(2)}${unit})`,
        `${Math.round(line.cap)}%`,
        over > 0
          ? `**at cap** — ${Math.round(over)} points already wasted`
          : `${Math.round(line.headroom)} more points of \`+%\``,
      ];
    }),
  );
  out.line();
  const notes: string[] = [];
  if (s.weapons.length) {
    notes.push(
      `attack base from ${s.weapons.map((w) => `**${w.item}** (${w.tag.toLowerCase() || 'no descriptor'}, ${w.aps.toFixed(2)}/s)`).join(' + ')}` +
        (s.attack.weaponNote?.includes('dwWeaponSpeedFactor')
          ? ' — dual-wielding weights each weapon at 0.5, so the pair contributes their mean'
          : ''),
    );
  }
  for (const line of [s.attack, s.cast, s.movement]) {
    if (line.rawPercentWithMaintainable > line.cap) {
      notes.push(
        `**${line.label} speed is capped**: the character carries ${Math.round(line.rawPercentWithMaintainable)}% against a ${Math.round(line.cap)}% ceiling, so every further \`+% ${line.label} Speed\` is worth nothing. ` +
          `Losing up to ${Math.round(line.rawPercentWithMaintainable - line.cap)} points of it costs nothing either.`,
      );
    }
  }
  notes.push(
    'The composition above (baseline × weapon delta × modifiers, capped on the result) is derived from the game data, not quoted from it — ' +
      'the caps and both bases are records, the way they combine is not. Treat the percentages as good to a point or two, and the *direction* — at cap or not — as reliable.',
  );
  out.bullets(notes);
}

const CELL_ZERO = '·';

function resistCells(values: ResistVector, blankZero = true): string[] {
  return RESIST_COLUMNS.map((c) => {
    const value = Math.round(values[c.key] ?? 0);
    return blankZero && value === 0 ? CELL_ZERO : String(value);
  });
}

function resistanceMatrix(out: Writer, ctx: RenderContext): void {
  const r = ctx.aggregate.resistances;
  const headers = ['source', ...RESIST_COLUMNS.map((c) => c.label)];

  out.h(3, 'Resistance matrix — one row per source, so a swap is computable');
  out.line('Every row is separately attributable: remove that source and exactly those numbers go with it. The two bands matter for how *reliable* a total is —');
  out.bullets([
    '**permanent** — items, affixes, components, augments, set bonuses, passives, toggled auras and devotion. Always on.',
    ctx.aggregate.maintained.length
      ? `**maintainable** — self-buffs whose duration is at least their cooldown, so they can be held up indefinitely, but only while the character keeps re-casting: ${ctx.aggregate.maintained.map((m) => `${m.name} (${num(m.duration ?? 0)}s duration / ${num(m.cooldown ?? 0)}s cooldown)`).join(', ')}. A resistance that only reaches cap in this band is fragile — say so rather than treating it as covered.`
      : '**maintainable** — empty for this character: nothing in the totals depends on keeping a buff up.',
  ]);
  out.line();

  const label = (row: MatrixRow): string => `${row.slot}: ${row.label}${row.note ? ` *(${row.note})*` : ''}`;
  const rows: string[][] = [];
  let band: string | undefined;
  for (const row of r.rows) {
    if (row.band !== band) {
      band = row.band;
      rows.push([`**— ${band} —**`, ...RESIST_COLUMNS.map(() => '')]);
    }
    rows.push([label(row), ...resistCells(row.values)]);
  }

  const overcap: ResistVector = {};
  for (const c of RESIST_COLUMNS) overcap[c.key] = (r.effective[c.key] ?? 0) - (r.caps[c.key] ?? 0);

  rows.push(
    ['**permanent total**', ...resistCells(r.permanent, false)],
    ['**+ maintainable buffs**', ...resistCells(r.withMaintainable, false)],
    [`**${r.difficulty} penalty**`, ...resistCells(r.penalty, false)],
    ['**effective**', ...resistCells(r.effective, false)],
    ['**cap**', ...resistCells(r.caps, false)],
    ['**over / (under) cap**', ...resistCells(overcap, false)],
  );
  out.table(headers, rows);

  // Physical Resistance is kept out of the shortfall list on purpose: §2 states
  // that no realistic loadout caps it, and a "-76" here reads as the single
  // biggest hole in the build — which mechanically tells the model to fix a
  // figure the game rules section just told it to ignore.
  const under = RESIST_COLUMNS.filter((c) => c.key !== 'physical' && (overcap[c.key] ?? 0) < 0);
  const physicalUnder = (overcap['physical'] ?? 0) < 0;
  const pastCap = overcapEndgame(ctx)
    ? 'points past cap count toward the §2 overcap target; only points past *that* are wasted'
    : 'points spent past cap are wasted except as buffer against enemy resistance reduction — §2: overcap is not a target at this stage';
  out.line();
  out.line(
    under.length
      ? `**Under cap** (each figure is that resistance, in points): ${under.map((c) => `${c.label} ${num(overcap[c.key] ?? 0)}`).join(' · ')}. Everything else is at or over cap; ${pastCap}.`
      : `**Every ${physicalUnder ? 'cappable ' : ''}resistance is at or above its cap** at this difficulty. Beyond that, ${pastCap}.`,
  );
  if (physicalUnder) {
    out.line();
    out.line(
      `Physical Resistance is ${num(r.effective['physical'] ?? 0)}% — **not counted as a shortfall**: see §2, no realistic loadout caps it.`,
    );
  }

  if (r.secondary.length) {
    out.line();
    out.line(`**Other resistances** (no cap, no difficulty penalty): ${r.secondary.map((s) => `${s.label} ${num(s.value)}%`).join(', ')}`);
  }

  out.line();
  out.line('**Not counted in any total above** — state these as unknowns rather than assuming they are zero:');
  out.bullets(ctx.aggregate.exclusions);
}

// ---------------------------------------------------------------------------
// 4 — skills, devotion, damage profile
// ---------------------------------------------------------------------------

/** How many stat lines a skill row shows before it is cut off. */
const SKILL_STAT_LINES = 6;

function buildProfile(out: Writer, ctx: RenderContext, trim: Trim): void {
  const { save, aggregate, db } = ctx;
  out.h(2, '4. Skills, devotion and build profile');

  const byRecord = new Map(aggregate.ranks.map((r) => [r.record, r]));

  // Modifier and transmuter nodes belong under the skill they modify.
  const attachments = new Map<string, string[]>();
  const standalone: typeof aggregate.ranks = [];
  for (const rank of aggregate.ranks) {
    const skill = db.getSkill(rank.record);
    if (!skill) continue;
    const cls = statRecord(skill, db).class;
    if (cls === 'Skill_Modifier' || cls === 'Skill_Transmuter') {
      const parent = modifierParent(rank.record, db);
      if (parent && byRecord.has(parent.record)) {
        const kind = cls === 'Skill_Transmuter' ? 'transmuter' : 'modifier';
        const stats = skillStatLine(skill, rank.effective, ctx);
        const list = attachments.get(parent.record) ?? [];
        list.push(`${kind} **${rank.name}** rank ${rank.effective}${stats ? ` — ${stats}` : ''}`);
        attachments.set(parent.record, list);
        continue;
      }
    }
    standalone.push(rank);
  }

  const masteries = standalone.filter((r) => db.getSkill(r.record)?.class === 'Skill_Mastery');
  if (masteries.length) {
    out.line(`**Mastery bars:** ${masteries.map((m) => `${m.name} ${m.invested}`).join(', ')} — points in the bar buy attributes and unlock tiers; lowering one is a respec decision.`);
    out.line();
  }
  out.line(`Unspent: ${save.attributes.skillPoints} skill point(s), ${save.attributes.devotionPoints} devotion point(s) of ${save.attributes.totalDevotionPoints} earned.`);
  out.line();

  const maintained = new Map(aggregate.maintained.map((m) => [m.name, m]));
  out.line('**Skills with points invested** (rank shown as invested + gear = effective; stats read at the effective rank):');
  out.line();
  for (const rank of standalone) {
    if (db.getSkill(rank.record)?.class === 'Skill_Mastery') continue;
    const skill = db.getSkill(rank.record);
    if (!skill) continue;
    const stats = statRecord(skill, db);
    const ceiling = stats.ultimateLevel ?? stats.maxLevel ?? skill.ultimateLevel ?? skill.maxLevel;
    const rankText = `${rank.invested}${rank.bonus ? ` +${rank.bonus}` : ''} = ${rank.effective}${ceiling ? `/${ceiling}` : ''}${rank.capped ? ' (capped — more +skills here is wasted)' : ''}`;
    const notes: string[] = [];
    const buff = maintained.get(rank.name);
    if (buff) notes.push(`maintainable buff, ${num(buff.duration ?? 0)}s duration / ${num(buff.cooldown ?? 0)}s cooldown`);
    if (skill.weapons?.length) notes.push(`requires: ${skill.weapons.join(', ')}`);
    const line = skillStatLine(skill, rank.effective, ctx);
    out.line(`- **${rank.name}** ${rankText}${notes.length ? ` *(${notes.join('; ')})*` : ''}${line ? ` — ${line}` : ''}`);
    for (const attached of attachments.get(rank.record) ?? []) out.line(`  - ${attached}`);
  }

  devotionSection(out, ctx);
  damageSection(out, ctx);
  if (trim.dropRankTables) {
    out.line();
    out.line('*(Rank-by-rank skill tables omitted to fit the token budget; skill stats above are at the current effective rank only.)*');
  } else {
    skillRankTables(out, ctx);
  }
}

function skillStatLine(skill: DbSkill, rank: number, ctx: RenderContext): string {
  const stats = statRecord(skill, ctx.db);
  const lines = formatStats(stats.stats, { db: ctx.db, read: atRank(rank), invested: ctx.invested });
  if (lines.length <= SKILL_STAT_LINES) return lines.join('; ');
  return `${lines.slice(0, SKILL_STAT_LINES).join('; ')}; … (${lines.length - SKILL_STAT_LINES} more)`;
}

function devotionSection(out: Writer, ctx: RenderContext): void {
  const { save, db } = ctx;
  const constellations = new Map<string, { stars: number; stats: Record<string, StatValue>[]; powers: string[] }>();

  for (const entry of save.devotions) {
    if (entry.level < 1) continue;
    const skill = db.getSkill(entry.record);
    if (!skill) continue;
    const name = skillLabel(skill, db);
    const group = constellations.get(name) ?? { stars: 0, stats: [], powers: [] };
    group.stars++;
    const stats = statRecord(skill, db);
    // A celestial power is the constellation's active; everything else is a
    // passive star whose numbers are already in the matrix above.
    if (stats.class.startsWith('Skill_Passive') || stats.class === 'SkillBuff_Passive') group.stats.push(stats.stats);
    else {
      const bound = entry.autoCastSkill ? db.skillName(entry.autoCastSkill) : undefined;
      group.powers.push(`${skillLabel(skill, db)}${bound ? ` — bound to ${bound}` : ' — unbound'}`);
    }
    constellations.set(name, group);
  }
  if (constellations.size === 0) return;

  out.line();
  out.line('**Devotion:**');
  for (const [name, group] of constellations) {
    const merged: Record<string, StatValue> = {};
    for (const stats of group.stats) {
      for (const [field, value] of Object.entries(stats)) {
        const previous = merged[field];
        if (typeof value === 'number') merged[field] = (typeof previous === 'number' ? previous : 0) + value;
        else if (previous === undefined) merged[field] = value;
      }
    }
    const lines = formatStats(merged, { db, read: atRank(1), invested: ctx.invested });
    const shown = lines.slice(0, SKILL_STAT_LINES).join('; ');
    out.line(`- **${name}** (${group.stars} star${group.stars === 1 ? '' : 's'})${shown ? ` — ${shown}` : ''}`);
    for (const power of group.powers) out.line(`  - celestial power: ${power}`);
  }
  out.line();
  out.line(
    'Devotion contributions are already inside the resistance matrix and the damage profile below, and they are **static** — no gear change moves them. Only the gear and skill share of any total is in play in this document.',
  );
}

/**
 * Whether the build's damage actually lands through weapon attacks. Flat gear
 * damage — and therefore the payload index — describes real output only when it
 * does; the cadence line and the yardstick advice both hang off this.
 */
function ridesWeaponAttacks(d: CharacterAggregate['damage']): boolean {
  return d.weaponAttack.composition.length > 0 || d.skillDamage.some((s) => s.weaponDamagePct);
}

function damageSection(out: Writer, ctx: RenderContext): void {
  const d = ctx.aggregate.damage;
  out.h(3, 'Damage profile (flat figures are post-conversion midpoints)');

  if (d.ranked.length) {
    out.table(
      ['damage type', '+% modifiers', 'flat (post-conversion)'],
      d.ranked
        .slice(0, 12)
        .map((e) => [`${e.label}${e.overTime ? ' *(over time)*' : ''}`, `${signed(e.percent)}%`, e.flat ? num(e.flat) : '·']),
    );
    out.line();
    // The composition rule, because the table alone invites the wrong weighing:
    // a model reading `+24%` beside `+10 flat` has no way to know the flat is
    // multiplied by the whole accumulated pool. Stated with the same caveat as
    // the attack-speed composition — the combining is engine behaviour.
    out.line(
      'Reading the table: flat damage joins the weapon-attack pool first, and the type\'s whole `+%` column then scales it — against `+N%`, one extra on-type flat point delivers ≈`1 + N/100` points, while another `+25%` is only a `25/(100+N)` relative gain. Gear flat reaches weapon attacks and `% Weapon Damage` skills only (§2). The combination is inferred engine behaviour, like §3\'s attack-speed composition — a strong direction, not an exact figure. §3\'s attribute damage bonus is *excluded* from the `+%` column here and joins the same pool.',
    );
    out.line();
  }
  if (d.totalDamagePercent) out.line(`\`+${num(d.totalDamagePercent)}% Total Damage\` scales every type at once and so ranks none of them.`);

  if (d.payloadIndex) {
    out.line();
    // The index measures what lands through weapon attacks, so it is the damage
    // yardstick only for a build whose damage actually rides them. On a caster
    // it prices a minor channel, and a plan told "you spent 30% of the payload"
    // would defend a cost that barely exists.
    const yardstick = ridesWeaponAttacks(d)
      ? "State a plan's overall damage cost as a delta against this index."
      : "This build's damage does not ride weapon attacks (see the cadence line below), so this index prices only a minor channel — judge a plan's damage cost against the build-focus types' `+%` columns above instead, and quote the index delta only as the secondary figure it is.";
    out.line(
      `**Weapon payload index: ${num(d.payloadIndex)}** — the post-conversion flat pools above, each scaled by its own \`+%\` column (incl. \`+% Total Damage\`), summed. An index in arbitrary units for comparing this loadout against a proposed one — **not DPS**: attack speed (§3 carries the rate), crit, skill \`% Weapon Damage\` multipliers and §3's attribute damage bonus are all excluded. ${yardstick}`,
    );
  }

  if (d.conversions.length) {
    out.line();
    out.line('**Global conversions** (already applied to the flat figures above):');
    out.bullets(d.conversions.map((c) => `${num(c.percent)}% ${c.from} → ${c.to} — ${c.source}, ${c.scope}`));
  }

  if (d.weaponAttack.composition.length) {
    const shares = d.weaponAttack.composition
      .map((s) => `${s.share}% ${s.label} Damage${s.overTime ? ' (over time)' : ''}`)
      .join(' · ');
    out.line();
    out.line(`**Weapon attack composition:** ${shares}${d.weaponAttack.mainAttack ? ` — main attack is **${d.weaponAttack.mainAttack}**` : ''}. This is what every point of flat damage on gear feeds. The shares cover gear and permanent buffs only — a default-attack replacer's own flat damage and \`% Weapon Damage\` multiplier are on its row below, not in these shares.`);
  }

  if (d.skillDamage.length) {
    out.line();
    out.line('**Per-skill damage typing** (a conversion or `+%` here belongs to that skill only, never to the character):');
    out.bullets(
      d.skillDamage.map((s) => {
        const parts = [
          ...(s.weaponDamagePct ? [`${s.weaponDamagePct}% weapon damage`] : []),
          ...(s.lifeLeechPercent ? [`${num(s.lifeLeechPercent)}% of Attack Damage converted to Health *(this skill only, on its whole damage)*`] : []),
          ...s.flat.map((f) => `${signed(f.amount)} ${f.label} Damage${f.overTime ? ' over time' : ''}`),
          ...s.ownPercent.map((p) => `${signed(p.percent)}% ${p.label} Damage *(this skill only)*`),
          ...(s.ownTotalPercent ? [`${signed(s.ownTotalPercent)}% Total Damage *(this skill only)*`] : []),
          ...s.conversions.map((c) => `converts ${num(c.percent)}% ${c.from} → ${c.to} *(this skill only)*`),
        ];
        return `**${s.skill}** rank ${s.rank}${s.isDefaultAttack ? ' *(default attack replacer)*' : ''}: ${parts.join(' · ') || 'no damage of its own'}`;
      }),
    );
  }

  if (d.resistReduction.length) {
    out.line();
    out.line(
      "**Resistance reduction the build applies to enemies** — offence, and a damage multiplier the `+%` columns above do not show. The stacking categories are community-established mechanics, not game data: `-X% Resistance` stacks from every source, while within each of the other two categories only the single strongest source applies.",
    );
    const groups: { category: ResistReductionRow['category']; label: string }[] = [
      { category: 'percent', label: 'stacks from every source (`-X% Resistance`)' },
      { category: 'flat', label: "flat `Reduced target's Resistances` — only the strongest applies" },
      { category: 'percentReduced', label: "`% Reduced target's Resistances` — only the strongest applies" },
      { category: 'other', label: 'adjacent enemy debuffs (no stacking claim)' },
    ];
    out.bullets(
      groups
        .map(({ category, label }) => {
          const rows = d.resistReduction.filter((rr) => rr.category === category);
          if (!rows.length) return '';
          const rendered = rows.map((rr) => {
            const qualifiers = [
              rr.rank ? `rank ${rr.rank}` : '',
              rr.durationSeconds ? `for ${num(rr.durationSeconds)}s` : '',
              rr.chance ? `${num(rr.chance)}% chance` : '',
            ].filter(Boolean);
            return `${rr.source} ${rr.effect}${qualifiers.length ? ` (${qualifiers.join(', ')})` : ''}`;
          });
          return `${label}: ${rendered.join('; ')}`;
        })
        .filter(Boolean),
    );
    out.line(
      "RR skills are conventionally kept at or near max rank — a candidate's `+N` to a skill listed here is a damage multiplier. RR on excluded procs (celestial powers, item procs) is not counted; see the exclusions in §3.",
    );
  }

  if (d.ranked.length) {
    const ridesAttack = ridesWeaponAttacks(d);
    out.line();
    out.line(
      ridesAttack
        ? "The build's damage cadence rides §3's **attack speed** line — the flat pools land through weapon attacks, so a swap that moves attack speed scales everything above."
        : "The build's damage cadence rides §3's **casting speed** line — the damage arrives through cast skills, so a swap that moves casting speed scales everything above.",
    );
  }

  wieldingLines(out, ctx);

  if (d.weaponRestrictions.length) {
    out.line();
    out.line('**Weapon-restricted skills** — a weapon outside the list bricks the skill:');
    out.bullets(d.weaponRestrictions.map((r) => `${r.skill}: ${r.weapons.join(', ')}`));
  }

  // Focus by magnitude, not by membership of a top-two list: +1043% Pierce
  // beside +150% Cold is one specialization and a minor line, not two paths.
  const top = d.ranked[0];
  out.line();
  if (!top) {
    out.line('**Build focus: undetermined** — no damage type has any investment yet.');
  } else {
    const focusLabel = (e: (typeof d.ranked)[number]): string => `${e.label} Damage (${signed(e.percent)}% modifiers)`;
    const secondaries = d.ranked.slice(1).filter((e) => e.percent > 0 && e.percent >= top.percent * 0.4);
    const minor = d.ranked.slice(1).find((e) => e.percent > 0 && e.percent < top.percent * 0.4);
    out.line(
      `**Build focus: ${[top, ...secondaries].map(focusLabel).join(' + ')}** — the post-conversion path every candidate's damage stats are judged against, weighted by these magnitudes.${
        minor
          ? ` ${focusLabel(minor)} and below are minor lines, not further specializations — a candidate serving only a minor line is off-focus.`
          : ''
      }`,
    );
    out.line();
    out.line(
      'An invested skill outside this focus can still earn its gear support for what it *does* — resistance reduction, crowd control, mobility, a defensive proc — judged by that role rather than by its damage type.',
    );
  }
}

/** Rank-by-rank tables: how many skills qualify before the rest are named in a note. */
const RANK_TABLE_CAP = 12;
/** Ranks shown below and above the effective rank (clamped to [1, ceiling]). */
const RANK_WINDOW_DOWN = 4;
const RANK_WINDOW_UP = 5;

/** Which vocabulary a rank table's rows use — see `skillRankTable`. */
type RankTableBand = 'attack' | 'buff';

/**
 * The per-skill rank tables: every attack and resistance-reduction skill's own
 * moving stats, tabulated over the ranks `+skills` gear can plausibly reach —
 * plus every permanent or maintainable **buff** whose per-rank stats move.
 *
 * This exists because a candidate carrying `+2 to <skill>` changes numbers that
 * are otherwise stated only at the current effective rank — the model was
 * honestly refusing to project them, and it was right to: the per-rank arrays
 * are in no other section. The buff extension closes the same gap from the
 * other side (the Bloodfrenzy case both live A/B models hit: a permanent
 * buff's per-rank `+% Attack Speed` appeared nowhere, so "attack speed after
 * Bloodfrenzy moves from 13 to 10" was honestly notDerivable — the computed
 * projection covers the consequence, these rows let the model read the cause).
 * These are the skills' *own* stats at rank, never a DPS figure. A modifier or
 * transmuter node has its own independent rank axis, so it gets its own table
 * rather than columns merged into its parent's.
 */
function skillRankTables(out: Writer, ctx: RenderContext): void {
  const { aggregate, db } = ctx;
  const d = aggregate.damage;
  const rrRecords = new Set(d.resistReduction.map((rr) => rr.record).filter((r): r is string => !!r));
  const attackRecords = new Set(d.skillDamage.map((s) => s.record));

  const attackTargets = aggregate.ranks.filter((rank) => {
    if (rank.invested < 1) return false;
    const skill = db.getSkill(rank.record);
    if (!skill) return false;
    if (attackRecords.has(rank.record) || rrRecords.has(rank.record)) return true;
    return ['attack', 'rr'].includes(classify(skill, db).band);
  });
  const attackSet = new Set(attackTargets.map((r) => r.record));

  // Buffs join after the attack/RR tables (those answer damage questions
  // first), and only where a qualifying per-rank array actually moves inside
  // the window — a buff whose stats are flat across every reachable rank has
  // nothing to tabulate. Ordered by gear-granted rank first, then investment:
  // a buff at rank 13 on 1 invested point (Bloodfrenzy, the case both live A/B
  // models hit) is the one most exposed to a gear swap, which is exactly the
  // question these tables answer — sorting by invested points alone dropped it
  // below the cap while its rank was the most movable of all.
  const buffTargets = aggregate.ranks
    .filter((rank) => {
      if (rank.invested < 1 || attackSet.has(rank.record)) return false;
      const skill = db.getSkill(rank.record);
      if (!skill) return false;
      const band = classify(skill, db).band;
      return (band === 'permanent' || band === 'maintainable') && buffStatsMove(ctx, rank);
    })
    .sort((a, b) => b.bonus - a.bonus || b.invested - a.invested);

  const targets: { rank: EffectiveRank; band: RankTableBand }[] = [
    ...attackTargets.map((rank) => ({ rank, band: 'attack' as const })),
    ...buffTargets.map((rank) => ({ rank, band: 'buff' as const })),
  ];
  if (!targets.length) return;

  out.line();
  out.h(3, 'Attack, resistance-reduction and moving-stat buff skills, rank by rank');
  out.line(
    "Read a candidate's `+N to <skill>` — or a rank lost with removed gear — against these columns; ranks right of the **bold** column are reachable only through more `+skills`. These are the skills' own stats at each rank, not DPS and not the character totals above. On a **buff**'s table the rows are global character modifiers while the buff is up; on an attack's they are marked *(this skill only)* where they are.",
  );
  out.line();

  const shown = targets.slice(0, RANK_TABLE_CAP);
  for (const target of shown) skillRankTable(out, ctx, target.rank, target.band);
  if (targets.length > shown.length) {
    out.line(
      `*(${targets.length - shown.length} more qualifying skill(s) omitted for space, smallest investments: ${targets
        .slice(RANK_TABLE_CAP)
        .map((t) => t.rank.name)
        .join(', ')})*`,
    );
  }
}

/** The stat families a buff's rank table rows come from. */
const BUFF_SPEED_ROWS: readonly { field: string; label: string }[] = [
  { field: 'characterAttackSpeedModifier', label: '+% Attack Speed' },
  { field: 'characterSpellCastSpeedModifier', label: '+% Casting Speed' },
  { field: 'characterRunSpeedModifier', label: '+% Movement Speed' },
  { field: 'characterTotalSpeedModifier', label: '+% Total Speed' },
];
const BUFF_ABILITY_ROWS: readonly { field: string; label: string }[] = [
  { field: 'characterOffensiveAbility', label: '+ Offensive Ability' },
  { field: 'characterOffensiveAbilityModifier', label: '+% Offensive Ability' },
  { field: 'characterDefensiveAbility', label: '+ Defensive Ability' },
  { field: 'characterDefensiveAbilityModifier', label: '+% Defensive Ability' },
];

/**
 * Whether a buff has anything to tabulate: a per-rank array among the families
 * the table rows — damage, speeds, OA/DA, resistances — whose values differ
 * inside the shown rank window.
 */
function buffStatsMove(ctx: RenderContext, rank: EffectiveRank): boolean {
  const { db } = ctx;
  const skill = db.getSkill(rank.record);
  if (!skill) return false;
  const stats = statRecord(skill, db);
  const { lo, hi } = rankWindow(stats, skill, rank);
  if (hi <= lo) return false;

  const sample = (r: number): string => {
    const read = atRank(r);
    const own = addDamage(emptyDamage(), stats.stats, read);
    const speed = addSpeed(emptySpeed(), stats.stats, read);
    const attrs = addAttributes(emptyAttributes(), stats.stats, read);
    const resists = resistContributions(stats.stats, read);
    return JSON.stringify([own.flat, own.percent, own.totalPercent, speed, attrs.oaFlat, attrs.oaPercent, attrs.daFlat, attrs.daPercent, resists]);
  };
  const first = sample(lo);
  for (let r = lo + 1; r <= hi; r++) if (sample(r) !== first) return true;
  return false;
}

/** The rank window a table shows, clamped to [1, ceiling]. */
function rankWindow(
  stats: DbSkill,
  skill: DbSkill,
  rank: EffectiveRank,
): { lo: number; hi: number; ceiling: number | undefined } {
  const ceiling = stats.ultimateLevel ?? stats.maxLevel ?? skill.ultimateLevel ?? skill.maxLevel;
  const lo = Math.max(1, rank.effective - RANK_WINDOW_DOWN);
  const hi = Math.min(ceiling ?? rank.effective + RANK_WINDOW_UP, rank.effective + RANK_WINDOW_UP);
  return { lo, hi, ceiling };
}

function skillRankTable(out: Writer, ctx: RenderContext, rank: EffectiveRank, band: RankTableBand): void {
  const { db } = ctx;
  const skill = db.getSkill(rank.record);
  if (!skill) return;
  const stats = statRecord(skill, db);
  const { lo, hi, ceiling } = rankWindow(stats, skill, rank);
  // A single-rank skill (devotion-style maxLevel 1) has no rank axis to show.
  if (hi <= lo) return;
  const window: number[] = [];
  for (let r = lo; r <= hi; r++) window.push(r);

  interface RankSample {
    weaponDamage: number;
    flat: Partial<Record<DamageKey, number>>;
    percent: Partial<Record<DamageKey, number>>;
    totalPercent: number;
    speed: ReturnType<typeof emptySpeed>;
    oaFlat: number;
    oaPercent: number;
    daFlat: number;
    daPercent: number;
    resists: ResistVector;
    rr: Map<string, number>;
    mana: number;
    lifeLeech: number;
  }
  const samples: RankSample[] = window.map((r) => {
    const read = atRank(r);
    const own = addDamage(emptyDamage(), stats.stats, read);
    const attrs = addAttributes(emptyAttributes(), stats.stats, read);
    const rrRows: ResistReductionRow[] = [];
    collectResistReduction(stats.stats, read, rank.name, rrRows, { negativeDefensiveIsRR: true });
    const rr = new Map<string, number>();
    // The effect with its number replaced by `N` doubles as a row label that
    // stays constant while the value moves: `-N% Enemy Cold Resistance`.
    for (const row of rrRows) rr.set(row.effect.replace(/[\d.]+/, 'N'), row.value);
    const wd = stats.stats['weaponDamagePct'];
    const mana = stats.stats['skillManaCost'];
    const leech = stats.stats['offensiveLifeLeechMin'];
    return {
      lifeLeech: leech === undefined ? 0 : read(leech),
      weaponDamage: wd === undefined ? 0 : read(wd),
      flat: own.flat,
      percent: own.percent,
      totalPercent: own.totalPercent,
      speed: addSpeed(emptySpeed(), stats.stats, read),
      oaFlat: attrs.oaFlat,
      oaPercent: attrs.oaPercent,
      daFlat: attrs.daFlat,
      daPercent: attrs.daPercent,
      resists: resistContributions(stats.stats, read),
      rr,
      mana: mana === undefined ? 0 : read(mana),
    };
  });

  const rows: string[][] = [];
  const cell = (n: number): string => (n ? num(n) : '·');
  if (samples.some((s) => s.weaponDamage)) {
    rows.push(['% Weapon Damage', ...samples.map((s) => cell(Math.round(s.weaponDamage)))]);
  }
  if (samples.some((s) => s.lifeLeech)) {
    rows.push(['% of Attack Damage converted to Health (this skill only)', ...samples.map((s) => cell(Math.round(s.lifeLeech * 10) / 10))]);
  }
  for (const type of DAMAGE_TYPES) {
    if (samples.some((s) => s.flat[type.key])) {
      rows.push([
        `${type.label} Damage (flat, midpoint)`,
        ...samples.map((s) => cell(Math.round(s.flat[type.key] ?? 0))),
      ]);
    }
  }
  // The same field means two different scopes by band: on an attack skill the
  // `+%` scales that skill alone, on a permanent/maintainable buff it is a
  // global character modifier — so the buff rows are labelled plainly, and
  // printing "(this skill only)" on them would be wrong, not merely noisy.
  const scope = band === 'attack' ? ' (this skill only)' : '';
  for (const type of DAMAGE_TYPES) {
    if (samples.some((s) => s.percent[type.key])) {
      rows.push([
        `+% ${type.label} Damage${scope}`,
        ...samples.map((s) => cell(Math.round(s.percent[type.key] ?? 0))),
      ]);
    }
  }
  if (samples.some((s) => s.totalPercent)) {
    rows.push([`+% Total Damage${scope}`, ...samples.map((s) => cell(Math.round(s.totalPercent)))]);
  }
  if (band === 'buff') {
    // The rows the Bloodfrenzy gap was about: character-wide speeds, OA/DA and
    // resistances whose per-rank arrays appear in no other section.
    for (const { field, label } of BUFF_SPEED_ROWS) {
      if (samples.some((s) => speedField(s.speed, field))) {
        rows.push([label, ...samples.map((s) => cell(Math.round(speedField(s.speed, field))))]);
      }
    }
    const abilityValue = (s: RankSample, field: string): number =>
      field === 'characterOffensiveAbility'
        ? s.oaFlat
        : field === 'characterOffensiveAbilityModifier'
          ? s.oaPercent
          : field === 'characterDefensiveAbility'
            ? s.daFlat
            : s.daPercent;
    for (const { field, label } of BUFF_ABILITY_ROWS) {
      if (samples.some((s) => abilityValue(s, field))) {
        rows.push([label, ...samples.map((s) => cell(Math.round(abilityValue(s, field))))]);
      }
    }
    for (const column of RESIST_COLUMNS) {
      if (samples.some((s) => s.resists[column.key])) {
        rows.push([
          `+% ${column.label} Resistance`,
          ...samples.map((s) => cell(Math.round(s.resists[column.key] ?? 0))),
        ]);
      }
    }
  }
  const rrLabels = new Set<string>();
  for (const s of samples) for (const label of s.rr.keys()) rrLabels.add(label);
  for (const label of rrLabels) {
    rows.push([label, ...samples.map((s) => cell(s.rr.get(label) ?? 0))]);
  }
  const manaValues = samples.map((s) => s.mana);
  if (Math.max(...manaValues) !== Math.min(...manaValues)) {
    rows.push(['Energy Cost per cast', ...manaValues.map((v) => cell(Math.round(v)))]);
  }
  if (!rows.length) return;

  const rankText = `rank ${rank.invested}${rank.bonus ? ` +${rank.bonus} from gear` : ' invested'} = **${rank.effective}**${ceiling ? ` of ${ceiling}` : ''}`;
  const bandNote = band === 'buff' ? ' *(buff — rows are global character modifiers while it is up)*' : '';
  out.line(`**${rank.name}** — ${rankText}${rank.capped ? ' (capped)' : ''}${bandNote}:`);
  out.table(
    ['stat at rank →', ...window.map((r) => (r === rank.effective ? `**${r}**` : String(r)))],
    rows,
  );
  out.line();
}

/** A `SpeedFields` value by its DBR field name — the row list speaks DBR. */
function speedField(speed: ReturnType<typeof emptySpeed>, field: string): number {
  switch (field) {
    case 'characterAttackSpeedModifier':
      return speed.attackPercent;
    case 'characterSpellCastSpeedModifier':
      return speed.castPercent;
    case 'characterRunSpeedModifier':
      return speed.runPercent;
    case 'characterTotalSpeedModifier':
      return speed.totalPercent;
    default:
      return 0;
  }
}

/**
 * How the weapons are held, and — on a dual-wield mode — what makes it legal.
 *
 * The two kinds of enabler get separate sentences and the *consequence* is
 * stated outright rather than left to be inferred. A flat "enabled by A; B; C.
 * Any swap must keep at least one of these" reads as though all three were
 * load-bearing, which is how the first live run came to keep a relic for a
 * grant that two invested passives already covered.
 */
function wieldingLines(out: Writer, ctx: RenderContext): void {
  const w = ctx.aggregate.wielding;
  out.line();
  const held = `**Wielding:** ${w.mode}${w.mainHand ? ` — ${w.mainHand}${w.offHand ? ` + ${w.offHand}` : ''}` : ''}.`;
  if (!w.mode.startsWith('dual-wield')) {
    out.line(held);
    return;
  }

  const permanent = w.enablers.filter((e) => e.source === 'skill');
  const granted = w.enablers.filter((e) => e.source !== 'skill');
  const list = (names: readonly DualWieldEnabler[]): string => names.map((e) => e.name).join(' and ');

  if (w.enablers.length === 0) {
    out.line(`${held} **No dual-wield enabler was found — treat this as a gap in the model, not permission to drop one.**`);
    return;
  }

  const parts = [
    permanent.length
      ? `**${permanent.length} permanent** — ${list(permanent)} (invested mastery passive${permanent.length === 1 ? '' : 's'}; they survive any gear change)`
      : '',
    granted.length
      ? `${granted.length} gear-granted — ${granted.map((e) => `${e.name}, ${e.source.replace(/^granted by /, 'from ')}`).join('; ')}`
      : '',
  ].filter(Boolean);

  out.line(`${held} Enabled by ${parts.join(' — and ')}.`);
  out.line(
    permanent.length
      ? '**Because a permanent enabler exists, no gear swap can end dual wielding.** Do not count an item\'s dual-wield grant as a reason to keep it.'
      : `**No permanent enabler.** Dual wielding depends entirely on gear: ${list(granted)}. A swap that removes the last of these while leaving two one-handers is illegal, not merely weak.`,
  );
}

// ---------------------------------------------------------------------------
// 5 — equipped
// ---------------------------------------------------------------------------

/** Where a resolved equipped item sits, in document order. */
const WEAPON_LOCATIONS = ['Weapon set 1 main', 'Weapon set 1 off', 'Weapon set 2 main', 'Weapon set 2 off'];

function equippedSection(out: Writer, ctx: RenderContext): void {
  const { aggregate } = ctx;
  out.h(2, '5. Equipped');
  out.line(`Advice is for **weapon set ${aggregate.weaponSet}** (the held one). The other set is inert until swapped to; treat its weapons as candidates.`);

  const checks = new Map(aggregate.equippedRequirements.map((e) => [e.item, e.check]));
  const byLocation = new Map(ctx.equipped.map((item) => [item.location, item]));

  for (const location of [...EQUIP_SLOT_NAMES, ...WEAPON_LOCATIONS]) {
    const item = byLocation.get(location);
    const held = location.startsWith('Weapon set')
      ? location.startsWith(`Weapon set ${aggregate.weaponSet}`)
      : true;
    const marker = location.startsWith('Weapon set') ? (held ? ' **[held]**' : ' *(inactive set)*') : '';
    if (!item) {
      out.line();
      out.line(`### ${location}${marker} — **EMPTY**`);
      continue;
    }
    out.line();
    itemBlock(out, ctx, item, `${location}${marker}`, checks.get(item.display));
  }
}

/** One item, rendered whole: identity, requirements, and every stat block. */
function itemBlock(
  out: Writer,
  ctx: RenderContext,
  item: ResolvedItem,
  heading: string,
  check?: RequirementCheck,
  level = 3,
): void {
  const { db } = ctx;
  const id = ctx.ids.get(item) ?? item.id;
  const base = item.base;
  out.line(`${'#'.repeat(level)} ${heading} — ${item.display} \`#${id}\``);
  const facts = [
    base?.rarity,
    base?.slot,
    weaponSpeed(base, db),
    base?.setName ? `set: ${base.setName}` : '',
    item.stackCount > 1 ? `×${item.stackCount}` : '',
  ].filter(Boolean);
  out.line(facts.join(' · '));
  out.line();

  out.line(`- requirements: ${requirementText(item, check)}`);
  // A candidate's `+N to <skill>` gets the rank arithmetic; a worn item's bonus
  // is already inside the effective rank, so annotating it would double-count.
  const worn = item.position.kind === 'equipment' || item.position.kind === 'weapon';
  const statLines = (stats: Record<string, number | string> | undefined, read?: (v: StatValue) => number) =>
    stats
      ? formatStats(stats, {
          db,
          invested: ctx.invested,
          ...(worn ? {} : { ranks: ctx.ranks }),
          ...(read ? { read } : {}),
        })
      : [];

  emit(out, 'base', statLines(base?.stats));
  if (item.prefix) emit(out, `prefix "${item.prefixName ?? '?'}"${jitter(item.prefix.jitter)}`, statLines(item.prefix.stats));
  if (item.suffix) emit(out, `suffix "${item.suffixName ?? '?'}"${jitter(item.suffix.jitter)}`, statLines(item.suffix.stats));
  if (item.modifier) emit(out, `${item.modifierName ?? 'crafting bonus'}${jitter(item.modifier.jitter)}`, statLines(item.modifier.stats));
  if (item.completion) emit(out, `relic completion bonus${jitter(item.completion.jitter)}`, statLines(item.completion.stats));

  if (item.component) {
    emit(out, `component: **${item.component.name}** \`#${socketableId(ctx, item.component)}\` (use-on: ${describeSlots(item.component.allowedSlots)})`, statLines(item.component.stats));
  } else if (acceptsComponent(item)) {
    out.line('- **component socket: EMPTY** — a free upgrade, no salvage needed');
  }
  if (item.augment) {
    emit(out, `augment: **${item.augment.name}** \`#${socketableId(ctx, item.augment)}\`${augmentSource(item.augment, db)}`, statLines(item.augment.stats));
    out.line('  - this item is **soulbound** while the augment is applied');
  } else if (acceptsAugment(item)) {
    out.line('- **augment: NONE** — buyable with iron, costs nothing to change later');
  }
  for (const miss of item.unresolved) out.line(`- unresolved record: \`${miss}\``);
}

/**
 * A weapon's base swing speed, which is a class tag rather than a number. Only
 * weapons carry a meaningful one — every armour template spells the field out
 * as "Average" filler, which is why `statfmt` drops it and this reads it here.
 */
function weaponSpeed(base: DbItem | undefined, db: GameDb): string {
  if (!base || !/^Weapon(Melee|Hunting)_/.test(base.slot)) return '';
  const tag = base.stats['characterBaseAttackSpeedTag'];
  if (typeof tag !== 'string') return '';
  const localized = db.localize(tag);
  // The localized string already reads "Speed:  Very Fast"; the tag fallback
  // does not. Normalize both to the bare descriptor.
  const name = (localized === tag ? tag.replace(/^(tag)?(Character)?AttackSpeed/i, '') : localized)
    .replace(/^speed:\s*/i, '')
    .trim();
  return name ? `${name.toLowerCase()} attack speed` : '';
}

function emit(out: Writer, label: string, lines: readonly string[]): void {
  if (lines.length === 0) return;
  out.line(`- ${label}: ${lines.join('; ')}`);
}

function jitter(pct: number | undefined): string {
  return pct ? ` *(base roll, ±${pct}%)*` : '';
}

function augmentSource(augment: DbItem, db: GameDb): string {
  const vendor = augment.vendors?.[0];
  const faction = vendor ? db.factions().find((f) => f.id === vendor.factionId)?.name ?? vendor.factionId : undefined;
  const cost = augment.stats['itemCost'];
  const bits = [
    faction ? `${faction}, ${vendor?.repTier}` : '',
    typeof cost === 'number' ? `${cost.toLocaleString('en-US')} iron` : '',
  ].filter(Boolean);
  return bits.length ? ` (${bits.join(', ')})` : '';
}

/** Gear takes a component; relics, jewelry medals and the like vary — ask the data. */
const COMPONENT_SLOTS = /^(ArmorProtective_|ArmorJewelry_|WeaponMelee_|WeaponHunting_|WeaponArmor_)/;

/**
 * Whether this kind of gear has a component socket at all. Exported for the
 * plan checks: `verify.ts` decides "the plan leaves this socket empty" with the
 * same rule the dossier used to print **component socket: EMPTY**, so the two
 * cannot drift apart.
 */
export function acceptsComponent(item: ResolvedItem): boolean {
  return COMPONENT_SLOTS.test(item.base?.slot ?? '');
}

export function acceptsAugment(item: ResolvedItem): boolean {
  return COMPONENT_SLOTS.test(item.base?.slot ?? '');
}

function requirementText(
  item: ResolvedItem,
  check?: RequirementCheck,
): string {
  const req = item.requirements;
  if (!req) return 'unknown (base record did not resolve)';
  const demands = [
    `level ${req.level}`,
    ...ATTR_KEYS.filter((key) => req[key] !== undefined).map((key) => `${num(req[key]!)} ${key}`),
  ];
  if (!check) return demands.join(', ');
  if (check.meets) return `${demands.join(', ')} — **meets**`;
  const gaps = check.gaps.map((gap) =>
    gap.attr === 'level'
      ? `**needs level ${gap.need}** (HOLD until then)`
      : `**short ${gap.deficit} ${gap.attr}** (have ${gap.have}, needs ${gap.need} after reductions)`,
  );
  return `${demands.join(', ')} — ${gaps.join('; ')}`;
}

// ---------------------------------------------------------------------------
// 6 — set status
// ---------------------------------------------------------------------------

function setStatus(out: Writer, ctx: RenderContext): void {
  const { db } = ctx;
  const sets = new Map<string, { set: DbSet; equipped: Set<string>; owned: Set<string> }>();
  for (const item of ctx.resolved.items) {
    const record = item.base?.setRecord;
    if (!record) continue;
    const set = db.getSet(record);
    if (!set) continue;
    const entry = sets.get(record) ?? { set, equipped: new Set<string>(), owned: new Set<string>() };
    if (item.source === 'equipped') entry.equipped.add(item.record);
    entry.owned.add(item.record);
    sets.set(record, entry);
  }
  if (sets.size === 0) return;

  out.h(2, '6. Item sets');
  out.line('Set counters count **distinct members** — a second copy of the same ring adds nothing. Bonus values are read at the equipped piece count.');

  const ordered = [...sets.values()].sort((a, b) => b.equipped.size - a.equipped.size || b.owned.size - a.owned.size);
  const active = ordered.filter((s) => s.equipped.size > 0);
  const dormant = ordered.filter((s) => s.equipped.size === 0);

  for (const { set, equipped, owned } of active) {
    const name = (record: string): string => db.getItem(record)?.name ?? record;
    out.line();
    out.line(`### ${set.name} — ${equipped.size}/${set.members.length} equipped, ${owned.size}/${set.members.length} owned`);
    const now = formatStats(set.bonuses, { db, read: atRank(equipped.size), invested: ctx.invested });
    out.line(`- active now (${equipped.size} piece${equipped.size === 1 ? '' : 's'}): ${now.length ? now.join('; ') : 'nothing at this piece count'}`);
    if (equipped.size < set.members.length) {
      const count = equipped.size + 1;
      const next = formatStats(set.bonuses, { db, read: atRank(count), invested: ctx.invested });
      out.line(`- at ${count} piece${count === 1 ? '' : 's'}: ${next.length ? next.join('; ') : 'nothing new'}`);
    }
    const ownedNotWorn = [...owned].filter((m) => !equipped.has(m)).map(name);
    if (ownedNotWorn.length) out.line(`- owned but not worn: ${ownedNotWorn.join(', ')}`);
    const missing = set.members.filter((m) => !owned.has(m)).map(name);
    if (missing.length) out.line(`- not owned: ${missing.join(', ')}`);
  }

  // Sets with pieces owned but none worn: one line each. Completing one from
  // here is a multi-slot move, so the detail only earns its tokens once a piece
  // is actually on.
  if (dormant.length) {
    out.line();
    out.line('**Sets with pieces owned but none equipped** (completing one from here means changing several slots at once):');
    out.bullets(
      dormant.map(
        ({ set, owned }) =>
          `${set.name} — ${owned.size}/${set.members.length} owned: ${[...owned].map((m) => db.getItem(m)?.name ?? m).join(', ')}`,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// 7 — candidates
// ---------------------------------------------------------------------------

const SOURCE_TAG: Readonly<Record<string, string>> = {
  inventory: '[inv]',
  stash: '[stash]',
  transfer: '[transfer]',
  equipped: '[equipped]',
  materials: '[materials]',
};

function candidateSelection(ctx: RenderContext, perGroup: number): CandidateSelection {
  const { aggregate } = ctx;
  const r = aggregate.resistances;
  // Physical is excluded here for the reason §3's under-cap list excludes it
  // (see `under` in the defences section): no realistic loadout caps it, so
  // it is always "short", and counting it as a shortfall handed every item
  // with a Physical Resistance line the ranking's dominant term and a "covers
  // a current resistance shortfall" note — the reading §2 tells the model to
  // ignore, printed in the same document.
  const shortfalls = new Set<ResistKey>(
    RESIST_COLUMNS.filter((c) => c.key !== 'physical' && (r.effective[c.key] ?? 0) < (r.caps[c.key] ?? 0)).map((c) => c.key),
  );
  const topDamage = new Set<DamageKey>(aggregate.damage.ranked.slice(0, 2).map((e) => e.key));
  const standing: CharacterStanding = {
    level: aggregate.level,
    attributes: {
      physique: aggregate.attributes.physique.total,
      cunning: aggregate.attributes.cunning.total,
      spirit: aggregate.attributes.spirit.total,
    },
    reductions: aggregate.requirementReductions,
  };
  return selectCandidates(ctx.resolved.items, {
    level: aggregate.level,
    standing,
    shortfalls,
    topDamage,
    unspentPoints: aggregate.attributes.unspentPoints,
    attributePerPoint: ctx.db.levelProgression().attributePerPoint,
    perGroup,
  });
}

/**
 * The carried gear §7 did not rank: outside the level window, or Common
 * covering nothing. Bags only — the same items in a stash stay unlisted,
 * because stored items are being kept on purpose and the plan is told to leave
 * them alone.
 *
 * Listed by name and id, without stats, so the plan can give each one the
 * disposition the coverage rule demands — mostly `sell`. Before this line
 * existed those items were invisible to the model, so a run's answer was
 * silent about a third of what the character was actually carrying, and the
 * reader could not tell "sell it" from "never saw it".
 */
function bagFodder(
  ctx: RenderContext,
  selection: CandidateSelection,
): { item: ResolvedItem; group: EquipGroup }[] {
  const ranked = new Set<ResolvedItem>();
  for (const list of selection.byGroup.values()) for (const c of list) ranked.add(c.item);
  const out: { item: ResolvedItem; group: EquipGroup }[] = [];
  for (const item of ctx.resolved.items) {
    if (item.source !== 'inventory' || ranked.has(item)) continue;
    const group = equipGroup(item.base);
    if (!group) continue;
    out.push({ item, group });
  }
  return out;
}

function candidatesSection(
  out: Writer,
  ctx: RenderContext,
  selection: CandidateSelection,
  fodder: readonly { item: ResolvedItem; group: EquipGroup }[],
  components: ReadonlyMap<string, CensusEntry>,
  augments: ReadonlyMap<string, CensusEntry>,
): void {
  out.h(2, '7. Candidates — everything not worn, by slot');
  out.line('Ranked by: covers a resistance shortfall > matches the build focus (post-conversion, counting the item\'s own conversion and armor piercing) > rarity > level proximity. A failing requirement is **not** a rejection — decide between an enabler combination, HOLD-until, and discard. Nor is a gain the loadout cannot absorb today: an item that is a real upgrade on one axis and opens a cost — a resistance under cap its line marks `not closable`, a broken set, the last dual-wield enabler — that nothing in this document covers yet is a HOLD with a stated condition (§11), not a discard.');

  if (ctx.projections.size) {
    out.line();
    out.line(
      '**Projected swaps.** Under each candidate, `projected in <slot>` is the tool\'s own arithmetic for that one swap against the loadout §3 and §5 describe: the save with the candidate in that slot, re-aggregated and diffed. Its sockets are **carried over** where they legally can be: the outgoing item\'s component refitted (a loose or craftable copy, else by salvaging the outgoing item) and its augment re-bought where a reached vendor sells it — the `sockets:` clause says which, and what it costs, so the figures are the item\'s own delta and not the socket package\'s. A socket the candidate already holds stays as saved, and an empty socket it still has is a further gain not counted; a carried-over component is projected without a rolled completion bonus, a slight understatement. Use it in place of your own subtraction. Where the swap leaves a cappable resistance short, `closable:` is one re-assignment of the loadout\'s armour augment sockets and the incoming component socket that closes every gap the swap opens — verified by the tool, ids included, a witness that it can be done and not a recommendation of how; `not closable` means by those means alone, and leaves jewellery and weapon augments, other components and joint moves to you. It sees exactly what §3 counts and **nothing on §3\'s exclusion list**: procs, granted skills, on-hit effects and set-completion *potential* are for you to weigh. **Projections do not add**: each is one swap against today\'s loadout, so a joint move is yours to sum from §3\'s rows, and past a cap the sum is not the sum of the parts. `no tracked figure improves` means exactly that and is **not a disposition** — a carried item still needs `hold` or `sell`, and a stored item is never sold. A ring, and a one-hander on a dual-wielder, is projected into each slot it could take.',
    );
    const levers = resistanceLevers(ctx, components, augments);
    if (levers.length) {
      out.line();
      out.line('**Levers per resistance** — what is reachable to raise each one, so the gap a swap opens can be costed. Build-independent: a table of what exists, not a recommendation. Free components first (loose on hand, or craftable now per §8), then §9\'s augments, largest first; each names the slots it may go in.');
      out.bullets(levers);
    }
  }

  for (const group of EQUIP_GROUPS) {
    const list = selection.byGroup.get(group);
    if (!list?.length) continue;
    const dropped = selection.dropped.get(group) ?? 0;
    out.line();
    out.line(`### ${group}${dropped ? ` *(${dropped} lower-ranked candidate${dropped === 1 ? '' : 's'} not shown)*` : ''}`);
    const worn = groupWornLines(ctx, list);
    if (worn.length) {
      out.line();
      out.bullets(worn);
    }
    for (const candidate of list) {
      out.line();
      candidateBlock(out, ctx, candidate);
    }
  }
  if (selection.outOfWindow) {
    out.line();
    out.line(`*(${selection.outOfWindow} further item(s) fell outside the level window around level ${ctx.aggregate.level} — −${LEVEL_WINDOW.below} below it, +${LEVEL_WINDOW.above} above it (+${LEVEL_WINDOW.aboveEndgame} for Epic and Legendary) — or were Common rarity covering nothing. The carried ones are named below; stored ones are omitted.)*`);
  }
  if (fodder.length) {
    out.line();
    out.line(`### Carried but unranked — ${fodder.length} item(s) in the bags`);
    out.line('Not ranked above (outside the level window, or Common covering nothing), but the character is carrying them, so each needs a disposition: put it in `sell` unless it is genuinely worth keeping, and say why if it is.');
    for (const { item, group } of fodder) {
      const level = item.requirements?.level ?? item.base?.levelReq;
      out.line(`- **${item.display}** \`#${ctx.ids.get(item) ?? item.id}\` (${group}${level ? `, level ${level}` : ''})`);
    }
  }
}

/** The build's top two post-conversion types, as the label §4 printed them. */
function focusLabels(ctx: RenderContext): string {
  const top = ctx.aggregate.damage.ranked.slice(0, 2).map((e) => e.label);
  return top.length ? top.join(' + ') : 'the build focus';
}

/**
 * The damage types a non-weapon candidate carries, for the off-type note. Only
 * weapons get a full `DamageIdentity`, but a belt with `+66% Cold Damage` is
 * off-type for a reason worth naming too.
 */
function offTypeDamageLabels(candidate: Candidate): string[] {
  const seen = new Set<string>();
  for (const stats of itemStatBlocks(candidate.item)) {
    const pools = addDamage(emptyDamage(), stats, (v) => (typeof v === 'number' ? v : 0));
    for (const type of DAMAGE_TYPES) {
      if (pools.flat[type.key] || pools.percent[type.key]) seen.add(type.label);
    }
  }
  return [...seen];
}

function candidateBlock(out: Writer, ctx: RenderContext, candidate: Candidate): void {
  const { item } = candidate;
  const tag = SOURCE_TAG[item.source] ?? `[${item.source}]`;
  itemBlock(out, ctx, item, `${tag} ${item.location}`, candidate.check, 4);

  const notes: string[] = [];
  if (candidate.covers.length) notes.push(`covers a current **resistance** shortfall in ${candidate.covers.join(', ')}`);
  if (candidate.identity) {
    const id = candidate.identity;
    const damage = id.types.map((t) => `${t.min}–${t.max} ${t.label} Damage`).join(', ');
    if (damage) {
      notes.push(`deals ${damage}${id.pierceRatio ? ` (${num(id.pierceRatio)}% Armor Piercing already applied)` : ''}`);
    }
    for (const conversion of id.conversions) {
      notes.push(`grants ${num(conversion.percent)}% ${conversion.from} → ${conversion.to} conversion (global once worn)`);
    }
  }
  // Both sides name their evidence. "off-type" alone reads as a verdict, and
  // "matches the build focus" alone hides that the match was one minor suffix.
  if (candidate.onTypeVia.length) {
    notes.push(`on-type via ${candidate.onTypeVia.join(', ')}`);
  } else {
    const lines = candidate.identity?.types.map((t) => t.label) ?? offTypeDamageLabels(candidate);
    const focus = focusLabels(ctx);
    notes.push(
      `off-type — ${lines.length ? `its damage lines are ${lines.join(', ')}; none is in ${focus}` : `it carries no ${focus} damage line`}. ` +
        (candidate.covers.length
          ? `This is not a rejection: it still covers ${candidate.covers.join(', ')} (see above).`
          : 'This is not a rejection on its own — weigh it against what else the item brings.'),
    );
  }
  if (candidate.outOfReach) notes.push('attribute gap exceeds what unspent points plus plausible gear support could close — a stat-stick for this character unless the loadout changes around it');
  out.bullets(notes.map((n) => `note: ${n}`));

  const projection = ctx.projections.get(item);
  if (projection) out.bullets(projection.targets.flatMap((target) => projectionLines(ctx, candidate, target)));
}

// ---------------------------------------------------------------------------
// 7 — projected swaps and resistance levers
// ---------------------------------------------------------------------------

const readScalar = (value: StatValue): number => (typeof value === 'number' ? value : 0);

/** `+12% Fire Resistance, +12% Acid Resistance` — a resist vector as typed stat text. */
function resistText(vector: ResistVector): string {
  return RESIST_COLUMNS.filter((c) => vector[c.key])
    .map((c) => `+${num(vector[c.key]!)}% ${c.label} Resistance`)
    .join(', ');
}

/** The +20 the community targets past the cap on an endgame Ultimate character (§2). */
const OVERCAP_TARGET = 20;

/**
 * The bullets under a candidate for one target slot. Type-first and
 * ` · `-separated throughout, so the document's own qualified-stat rule holds
 * on every figure; non-zero changes only, and the trailing clause says so.
 */
function projectionLines(ctx: RenderContext, candidate: Candidate, target: SlotProjection): string[] {
  const { item } = candidate;
  const lines: string[] = [];
  const replacing = target.outgoing
    ? `replacing ${target.outgoing.display} \`#${ctx.ids.get(target.outgoing) ?? target.outgoing.id}\``
    : 'the slot is empty';

  if (!target.projection) {
    lines.push(`not projected in ${target.slot} (${replacing}): ${target.skipped ?? 'no reason recorded'}`);
    return lines;
  }
  const p = target.projection;
  const parts: string[] = [];
  const endgame = overcapEndgame(ctx);

  for (const r of p.resistances) {
    if (r.after === r.before) continue;
    // Physical is exempt from the cap rule (§2): its figure moves, its alarm does not.
    let flag = '';
    if (r.label === 'Physical') flag = '';
    else if (r.after < r.capAfter) flag = ` (**${num(r.capAfter - r.after)} under cap**)`;
    else if (endgame && r.after < r.capAfter + OVERCAP_TARGET) flag = ` (${num(r.capAfter + OVERCAP_TARGET - r.after)} short of the §2 overcap target)`;
    parts.push(`${r.label} Resistance ${num(r.before)} → ${num(r.after)}${flag}`);
  }

  const focus = new Set(ctx.aggregate.damage.ranked.slice(0, 2).map((e) => e.key));
  for (const d of p.damage) {
    if (!focus.has(d.key as DamageKey)) continue;
    if (d.percentAfter !== d.percentBefore) parts.push(`${d.label} Damage +${num(d.percentBefore)}% → +${num(d.percentAfter)}%`);
    if (d.flatAfter !== d.flatBefore) parts.push(`${d.label} Damage ${num(d.flatBefore)} → ${num(d.flatAfter)} flat`);
  }
  if (p.payload && p.payload.before > 0 && p.payload.after !== p.payload.before) {
    const pct = ((p.payload.after - p.payload.before) / p.payload.before) * 100;
    parts.push(`weapon payload index ${signed(Math.round(pct * 10) / 10)}%`);
  }
  for (const s of p.speeds) {
    if (s.after !== s.before) parts.push(`${s.label.toLowerCase()} speed ${num(s.before)}% → ${num(s.after)}%`);
  }
  const d = p.defense;
  if (d) {
    const delta = (label: string, pair: { before: number; after: number }, suffix = ''): void => {
      if (pair.after !== pair.before) parts.push(`${label} ${signed(Math.round((pair.after - pair.before) * 10) / 10)}${suffix}`);
    };
    delta('Offensive Ability', d.offensiveAbility.flat);
    delta('Offensive Ability', d.offensiveAbility.percent, '%');
    delta('Defensive Ability', d.defensiveAbility.flat);
    delta('Defensive Ability', d.defensiveAbility.percent, '%');
    delta('Health', d.health.flat);
    delta('Health', d.health.percent, '%');
    if (d.armorMean.after !== d.armorMean.before) parts.push(`armour (hit-weighted mean) ${num(d.armorMean.before)} → ${num(d.armorMean.after)}`);
    if (d.absorption.after !== d.absorption.before) parts.push(`absorption ${num(d.absorption.before)}% → ${num(d.absorption.after)}%`);
    if (d.sustain && d.sustain.after !== d.sustain.before) {
      parts.push(`sustain ${num(d.sustain.before)}% → ${num(d.sustain.after)}% of Attack Damage converted to Health`);
    }
    for (const key of ATTR_KEYS) {
      const pair = d.attributes[key];
      if (Math.round(pair.after) !== Math.round(pair.before)) parts.push(`${key} ${Math.round(pair.before)} → ${Math.round(pair.after)}`);
    }
  }
  for (const r of p.skillRanks) parts.push(`${r.skill} rank ${r.before} → ${r.after}`);
  // A set bonus starts at two pieces, so 1 → 0 moves nothing worth a clause.
  for (const s of target.setPieces) {
    if (s.before >= 2 || s.after >= 2) parts.push(`${s.set} set ${s.before} → ${s.after} pieces`);
  }
  // What went into the candidate's sockets for this projection, so the reader
  // can write it into `fits` — and what did not, so the figure is not read as
  // including it.
  const sockets: string[] = [];
  const carried = target.carried;
  if (carried.component) {
    const via =
      carried.component.via === 'loose'
        ? 'a loose copy'
        : carried.component.via === 'craftable'
          ? 'craftable now'
          : `by salvaging ${target.outgoing?.display ?? 'the outgoing item'} — destroys it; name it in componentFrom`;
    sockets.push(`${carried.component.item.name} carried over (${via})`);
  }
  if (carried.augment) sockets.push(`${carried.augment.item.name} re-bought (${carried.augment.rebuy ?? 'see §9'})`);
  sockets.push(...carried.notCarried);
  if (sockets.length) parts.push(`sockets: ${sockets.join(', ')}`);
  if (target.gaps.length) {
    if (target.closable) parts.push(`closable: ${closableText(ctx, target, target.closable)}`);
    else if (target.notClosable) parts.push(`${target.notClosable} — jewellery and weapon augments, other components and joint moves are yours`);
  }
  if (target.unworn.length) parts.push(`un-wears ${target.unworn.join(', ')}`);
  if (target.postSwap) {
    parts.push(`requirements once ${target.outgoing?.display ?? 'the slot'} leaves: ${requirementText(item, target.postSwap)}`);
  }
  for (const note of target.notes) parts.push(note);

  const body = target.identical
    ? 'every tracked figure holds still'
    : `${parts.join(' · ')}${parts.length ? ' · ' : ''}unchanged: everything not listed`;
  lines.push(`projected in ${target.slot} (${replacing}): ${body}`);
  if (target.noTrackedGain) lines.push('no tracked figure improves — see the §7 preamble for exactly what that does and does not mean');
  return lines;
}

/** The resistance fields `resistContributions` reads — everything else on a socketable is a side line. */
const RESIST_FIELDS = new Set<string>([...RESIST_COLUMNS.map((c) => c.field), 'defensiveElementalResistance', 'defensiveAllResistance']);

/** A socketable's lines that are not resistances — what a re-assignment gives up besides the resistance it trades. */
function sideLines(ctx: RenderContext, item: DbItem): string[] {
  const stats = Object.fromEntries(Object.entries(item.stats).filter(([field]) => !RESIST_FIELDS.has(field)));
  return formatStats(stats, { db: ctx.db, invested: ctx.invested });
}

/**
 * The witness, as one clause: each re-augment with what it displaces and what
 * that gives up, the component fill if one was needed, the iron, and the claim
 * — every gap the swap opened, closed. Ids on every socketable so the plan
 * can carry them into `fits` and `RE-AUGMENT` as they stand.
 */
function closableText(ctx: RenderContext, target: SlotProjection, witness: ClosableWitness): string {
  const bits: string[] = [];
  for (const r of witness.reaugments) {
    const lost = r.replaces ? sideLines(ctx, r.replaces) : [];
    const displaced = r.replaces ? ` in place of ${r.replaces.name}${lost.length ? ` (gives up ${lost.join(', ')})` : ''}` : '';
    bits.push(`${r.augment.item.name} \`#${socketableId(ctx, r.augment.item)}\` on ${r.slot}${displaced}`);
  }
  if (witness.fill) {
    const { component, displaces } = witness.fill;
    const dropped = displaces ? formatStats(displaces.stats, { db: ctx.db, invested: ctx.invested }) : [];
    bits.push(
      `${component.item.name} \`#${socketableId(ctx, component.item)}\` in the ${target.slot} socket (${component.source === 'loose' ? 'a loose copy' : 'craftable now'})` +
        (displaces ? ` instead of ${displaces.name}${dropped.length ? ` (drops ${dropped.join(', ')})` : ''}` : ''),
    );
  }
  const iron = witness.iron ? `${witness.iron.toLocaleString('en-US')} iron` : 'no iron';
  return `${bits.join(' · ')} — ${iron}; closes every gap the swap opens`;
}

/**
 * What every candidate of a group is up against: the worn item in each slot
 * the group maps to, and the socketables that leave with it. Stated once
 * under the group heading rather than under each candidate — the outgoing
 * item is the same for all of them; only whether its component *refits* is
 * per candidate, and that clause is on the projection line.
 */
function groupWornLines(ctx: RenderContext, list: readonly Candidate[]): string[] {
  const first = list[0] && ctx.projections.get(list[0].item);
  if (!first) return [];
  return first.targets
    .filter((t) => t.outgoing)
    .map((t) => {
      const worn = t.outgoing!;
      const departing = t.departing.map((s) => {
        const id = ctx.socketableIds.get(s.item.record) ?? shortHash(s.item.record);
        const stats = resistText(s.resist) || 'no resistance lines';
        return s.kind === 'component'
          ? `component ${s.item.name} \`#${id}\` (${stats}) — recovering it destroys ${worn.display}`
          : `augment ${s.item.name} \`#${id}\` (${stats}) — lost${s.rebuy ? `; re-buy ${s.rebuy}` : '; no vendor reached sells it'}`;
      });
      return `worn in ${t.slot}: ${worn.display} \`#${ctx.ids.get(worn) ?? worn.id}\`${departing.length ? ` — leaves with it: ${departing.join(' · ')}` : ''}`;
    });
}

/** One bullet per cappable resistance: the free components, loose augments and buyable augments that raise it, largest first. */
function resistanceLevers(
  ctx: RenderContext,
  components: ReadonlyMap<string, CensusEntry>,
  augments: ReadonlyMap<string, CensusEntry>,
): string[] {
  const free = [
    ...[...components.values()].filter((e) => e.loose.size > 0 || (e.craft && e.craft.plan.missing.length === 0)),
    ...augments.values(),
  ];
  const stock = vendorStock(ctx.save, ctx.db, ctx.aggregate.level);
  const LEVERS_SHOWN = 6;
  const lines: string[] = [];
  for (const column of RESIST_COLUMNS) {
    if (column.key === 'physical') continue;
    const entries: { text: string; value: number; order: number }[] = [];
    const seen = new Set<string>();
    for (const e of free) {
      const value = resistContributions(e.item.stats, readScalar)[column.key] ?? 0;
      if (value <= 0) continue;
      const loose = [...e.loose.values()].reduce((a, b) => a + b, 0);
      if (loose) seen.add(e.item.record);
      entries.push({
        value,
        order: loose ? 0 : 1,
        text: `${e.item.name} \`#${socketableId(ctx, e.item)}\` +${num(value)}% (${describeSlots(e.item.allowedSlots)}; ${loose ? `loose ${loose}×` : 'craftable now'})`,
      });
    }
    for (const s of stock) {
      for (const a of s.augments) {
        // A loose copy is already listed as free; the vendor line would be the same augment at a price.
        if (seen.has(a.record)) continue;
        const value = resistContributions(a.stats, readScalar)[column.key] ?? 0;
        if (value <= 0) continue;
        seen.add(a.record);
        const cost = a.stats['itemCost'];
        entries.push({
          value,
          order: 2,
          text: `${a.name} \`#${socketableId(ctx, a)}\` +${num(value)}% (${describeSlots(a.allowedSlots)}; ${s.factionName} ${s.tier}, ${typeof cost === 'number' ? cost.toLocaleString('en-US') : '?'} iron)`,
        });
      }
    }
    if (!entries.length) continue;
    entries.sort((x, y) => y.value - x.value || x.order - y.order);
    const shown = entries.slice(0, LEVERS_SHOWN);
    const more = entries.length - shown.length;
    lines.push(`**${column.label} Resistance**: ${shown.map((e) => e.text).join(' · ')}${more ? ` · ${more} smaller in §8/§9` : ''}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 8 — component census and materials
// ---------------------------------------------------------------------------

const COMPONENT_CLASS = 'ItemRelic';
const AUGMENT_CLASS = 'ItemEnchantment';
const MATERIAL_PREFIX = 'records/items/crafting/materials/';

interface CensusEntry {
  item: DbItem;
  /** Loose copies by container, as counts. */
  loose: Map<string, number>;
  /** Item ids of gear this component is installed in. */
  hosts: { id: string; where: string }[];
  /** A learned blueprint that produces it, when one exists. */
  craft?: { recipe: DbRecipe; plan: CraftPlan };
}

/**
 * Every component the character can reach, from any origin, in one place.
 *
 * Owned, installed and *craftable* are three ways of having the same component,
 * and the choice between them is a single decision — so they belong in a single
 * list rather than split between a census and a blueprint section. Each entry
 * carries its stats for the same reason: "any component beats an empty socket"
 * is what an advisor is reduced to saying when the numbers are elsewhere.
 */
function componentCensus(ctx: RenderContext, selection: CandidateSelection): Map<string, CensusEntry> {
  const shown = new Map<ResolvedItem, string>();
  for (const item of ctx.equipped) shown.set(item, ctx.ids.get(item) ?? item.id);
  for (const candidate of [...selection.byGroup.values()].flat()) {
    shown.set(candidate.item, ctx.ids.get(candidate.item) ?? candidate.item.id);
  }

  const components = new Map<string, CensusEntry>();
  const entry = (item: DbItem): CensusEntry => {
    const existing = components.get(item.record) ?? { item, loose: new Map<string, number>(), hosts: [] };
    components.set(item.record, existing);
    return existing;
  };

  for (const item of ctx.resolved.items) {
    if (item.base?.slot === COMPONENT_CLASS) {
      const e = entry(item.base);
      e.loose.set(item.source, (e.loose.get(item.source) ?? 0) + Math.max(1, item.stackCount));
    }
    // Installed copies. Anything not printed elsewhere is still named by its
    // host's location, so "the only copy is inside this item" stays visible.
    if (item.component) {
      const id = shown.get(item) ?? ctx.ids.get(item) ?? item.id;
      entry(item.component).hosts.push({ id, where: `${item.display} (${item.location})` });
    }
  }

  for (const recipe of ctx.recipes.relevant) {
    const result = recipe.resultRecord ? ctx.db.getItem(recipe.resultRecord) : undefined;
    if (result?.slot !== COMPONENT_CLASS) continue;
    const e = entry(result);
    if (!e.craft) e.craft = { recipe, plan: ctx.recipes.planFor(recipe) };
  }

  return components;
}

/**
 * The loose augments on hand, by record. Same shape as the component census
 * (`hosts` stays empty — an installed augment is never recoverable), so the
 * levers table can list a loose augment beside a loose component: a Venomguard
 * Powder already in the bag is the cheapest Acid lever there is, and for a
 * while it was the one the table left out.
 */
function augmentCensus(ctx: RenderContext): Map<string, CensusEntry> {
  const augments = new Map<string, CensusEntry>();
  for (const item of ctx.resolved.items) {
    if (item.base?.slot !== AUGMENT_CLASS) continue;
    const e = augments.get(item.base.record) ?? { item: item.base, loose: new Map<string, number>(), hosts: [] };
    e.loose.set(item.source, (e.loose.get(item.source) ?? 0) + Math.max(1, item.stackCount));
    augments.set(item.base.record, e);
  }
  return augments;
}

function census(
  out: Writer,
  ctx: RenderContext,
  components: Map<string, CensusEntry>,
  augments: ReadonlyMap<string, CensusEntry>,
  trim: Trim,
): void {
  const materials = new Map<string, { name: string; count: number }>();
  for (const item of ctx.resolved.items) {
    if (!item.record.startsWith(MATERIAL_PREFIX)) continue;
    const existing = materials.get(item.record) ?? { name: item.base?.name ?? item.record, count: 0 };
    existing.count += Math.max(1, item.stackCount);
    materials.set(item.record, existing);
  }

  const craftableNow = [...components.values()].filter((e) => e.craft && e.craft.plan.missing.length === 0);

  out.h(2, '8. Components and augments — everything reachable, from every source');
  out.line(
    'This is the **single list of components**: owned loose, installed in gear, and craftable from a learned blueprint, each with what it actually grants. ' +
      'Scarcity is the point — a component whose only copy is installed can still be moved, but only by destroying its host, while a craftable one is unlimited if the materials hold out.',
  );

  if (trim.compressCensus) {
    out.line();
    out.line(`- ${components.size} distinct component(s) reachable, ${[...components.values()].filter(onlyInstalled).length} of them only as an installed copy, ${craftableNow.length} craftable now`);
    out.line(`- ${augments.size} distinct loose augment(s) on hand`);
  } else {
    out.line();
    out.line(`**Components** (${components.size} reachable, ${craftableNow.length} of them craftable right now):`);
    for (const e of [...components.values()].sort((a, b) => a.item.name.localeCompare(b.item.name))) {
      const loose = [...e.loose].map(([source, n]) => `${n}× ${SOURCE_TAG[source] ?? source}`).join(', ');
      const parts = [
        loose ? `loose: ${loose}` : 'none loose',
        e.hosts.length ? `installed in ${e.hosts.map((h) => `\`#${h.id}\` ${h.where}`).join(', ')}` : '',
        craftText(e),
        `use-on: ${describeSlots(e.item.allowedSlots)}`,
      ].filter(Boolean);
      const scarce = onlyInstalled(e)
        ? ` — **single instance — extraction destroys ${e.hosts.map((h) => `\`#${h.id}\``).join(' / ')}**`
        : '';
      out.line(`- **${e.item.name}** \`#${socketableId(ctx, e.item)}\` — ${parts.join('; ')}${scarce}`);
      // The stats are the whole point of the comparison: without them the
      // advisor can only say "any component beats an empty socket".
      const lines = formatStats(e.item.stats, { db: ctx.db, invested: ctx.invested });
      if (lines.length) out.line(`  - ${lines.join('; ')}`);
    }

    if (augments.size) {
      out.line();
      out.line('**Loose augments on hand** (installed ones are shown with their item in §5/§7 and can never be recovered):');
      for (const e of [...augments.values()].sort((a, b) => a.item.name.localeCompare(b.item.name))) {
        const loose = [...e.loose].map(([source, n]) => `${n}× ${SOURCE_TAG[source] ?? source}`).join(', ');
        out.line(`- **${e.item.name}** \`#${socketableId(ctx, e.item)}\` — ${loose}; use-on: ${describeSlots(e.item.allowedSlots)}`);
        const lines = formatStats(e.item.stats, { db: ctx.db, invested: ctx.invested });
        if (lines.length) out.line(`  - ${lines.join('; ')}`);
      }
    }
  }

  out.line();
  out.line(
    materials.size
      ? `**Crafting materials on hand:** ${[...materials.values()].sort((a, b) => b.count - a.count).map((m) => `${m.name} ×${m.count}`).join(' · ')}`
      : '**Crafting materials on hand:** none.',
  );
}

/**
 * A socketable's dossier id. Falls back to hashing the record on the spot: a
 * component that reached a render path the id map missed should still print an
 * id rather than a gap, and the hash is deterministic, so it is the same id the
 * map would have given.
 */
function socketableId(ctx: RenderContext, item: DbItem): string {
  return ctx.socketableIds.get(item.record) ?? shortHash(item.record);
}

/**
 * How each component can be had for free — the census rule `freeComponentIds`
 * applies, keyed by record for the projections: a loose copy first, else a
 * blueprint craftable right now.
 */
function freeComponentSources(components: ReadonlyMap<string, CensusEntry>): Map<string, 'loose' | 'craftable'> {
  const out = new Map<string, 'loose' | 'craftable'>();
  for (const e of components.values()) {
    if (e.loose.size > 0) out.set(e.item.record, 'loose');
    else if (e.craft && e.craft.plan.missing.length === 0) out.set(e.item.record, 'craftable');
  }
  return out;
}

/**
 * Every augment the closable search may spend: loose on hand (free), else the
 * faction stock at reached tiers, with its price. One entry per record — a
 * loose copy wins over the same augment at a vendor.
 */
function augmentUniverse(ctx: RenderContext, loose: ReadonlyMap<string, CensusEntry>): AugmentOption[] {
  const out = new Map<string, AugmentOption>();
  for (const e of loose.values()) out.set(e.item.record, { item: e.item, source: 'loose', iron: 0 });
  for (const s of vendorStock(ctx.save, ctx.db, ctx.aggregate.level)) {
    for (const a of s.augments) {
      if (out.has(a.record)) continue;
      const cost = a.stats['itemCost'];
      out.set(a.record, { item: a, source: `${s.factionName} ${s.tier}`, iron: typeof cost === 'number' ? cost : 0 });
    }
  }
  return [...out.values()];
}

function onlyInstalled(entry: CensusEntry): boolean {
  return entry.hosts.length === 1 && entry.loose.size === 0 && entry.craft === undefined;
}

/** The craft origin of a census entry: what it costs, or what is still missing. */
function craftText(entry: CensusEntry): string {
  if (!entry.craft) return '';
  const { recipe, plan } = entry.craft;
  const reagents = [...(recipe.baseReagent ? [recipe.baseReagent] : []), ...recipe.reagents]
    .map((r) => `${r.quantity}× ${r.name ?? r.record}`)
    .join(', ');
  const cost = `${plan.ironTotal.toLocaleString('en-US')} iron`;
  // How it is known matters when it is *not* craftable: "blueprint learned"
  // about a smith's default recipe claims a learning that never happened.
  const way = recipe.alwaysKnown ? 'any blacksmith crafts it, but' : 'blueprint learned but';
  if (plan.missing.length) return `${way} **not craftable**: needs ${reagents}, ${cost} — missing ${plan.missing.join(', ')}`;
  const first = plan.prerequisites.length ? `, after first crafting ${plan.prerequisites.join(', ')}` : '';
  return `**craftable now** from ${reagents}, ${cost}${first}`;
}

// ---------------------------------------------------------------------------
// 9 — faction augments
// ---------------------------------------------------------------------------

/** Tiers up to and including the one reached, ascending. */
function tiersUpTo(tier: string): RepTier[] {
  const index = REP_TIERS.indexOf(tier as RepTier);
  return index < 0 ? [] : REP_TIERS.slice(0, index + 1);
}

interface VendorStock {
  factionId: string;
  factionName: string;
  tier: RepTier | string;
  reputation: number;
  augments: DbItem[];
}

/**
 * The faction augment stock this character can actually buy today, grouped by
 * faction. One derivation feeding §2's iron verdict, §9's listing and the
 * socketable index Stage 6 validates against — three readers of the same three
 * filters (faction unlocked, tier reached, level appropriate) is three chances
 * for them to drift apart.
 */
export function vendorStock(save: CharacterSave, db: GameDb, level: number): VendorStock[] {
  const out: VendorStock[] = [];
  for (const rep of save.factions) {
    if (!rep.unlocked) continue;
    const slot = factionSlot(rep.id);
    if (!slot) continue;
    const tier = factionTier(rep.value);
    const reached = tiersUpTo(tier);
    if (reached.length === 0) continue;
    const faction = db.factions().find((f) => f.id === slot.id);
    if (!faction?.hasVendor) continue;
    const augments = db
      .vendorItems(slot.id, reached.at(-1)!)
      .filter((item) => item.slot === AUGMENT_CLASS && item.levelReq <= level);
    if (augments.length === 0) continue;
    out.push({ factionId: slot.id, factionName: faction.name, tier, reputation: rep.value, augments });
  }
  return out;
}

/**
 * Every component and augment the document actually offers: the ones installed
 * in gear (§5/§7), the loose and craftable ones in §8, and the faction stock the
 * character can buy today (§9).
 *
 * Stage 6 checks socket proposals against exactly this set, which is why it is
 * derived here rather than from the whole database — a component the document
 * never showed is a hallucination even though the game has one. Conversely a
 * component §8 marks craftable *was* offered, so it belongs here: leaving it out
 * would report a legal CRAFT as invented.
 */
export function documentSocketables(input: ContextInput, recipes?: RecipeView): DbItem[] {
  const { save, db, aggregate, resolved } = input;
  const out = new Map<string, DbItem>();
  const add = (item: DbItem | undefined): void => {
    if (item) out.set(item.record, item);
  };

  for (const item of resolved.items) {
    if (item.base && (item.base.slot === COMPONENT_CLASS || item.base.slot === AUGMENT_CLASS)) add(item.base);
    add(item.component);
    add(item.augment);
  }

  for (const stock of vendorStock(save, db, aggregate.level)) {
    for (const augment of stock.augments) add(augment);
  }

  for (const recipe of (recipes ?? recipeView(input)).relevant) {
    const result = recipe.resultRecord ? db.getItem(recipe.resultRecord) : undefined;
    if (result?.slot === COMPONENT_CLASS) add(result);
  }

  return [...out.values()];
}

function factionAugments(out: Writer, ctx: RenderContext): void {
  const { save, db, aggregate } = ctx;
  out.h(2, '9. Faction augments available now');
  out.line('Only factions this character has unlocked, only tiers actually reached, only augments at or below the character\'s level. Prices are per augment; iron on hand is in §1.');

  const groups = vendorStock(save, db, aggregate.level);
  for (const group of groups) {
    out.line();
    out.line(`### ${group.factionName} — ${group.tier} (${Math.round(group.reputation).toLocaleString('en-US')} reputation)`);
    for (const augment of [...group.augments].sort((a, b) => b.levelReq - a.levelReq || a.name.localeCompare(b.name))) {
      const at = augment.vendors?.find((v) => v.factionId === group.factionId)?.repTier ?? group.tier;
      const cost = augment.stats['itemCost'];
      const lines = formatStats(augment.stats, { db, invested: ctx.invested });
      out.line(
        `- **${augment.name}** \`#${socketableId(ctx, augment)}\` (lvl ${augment.levelReq}, ${at}, ${typeof cost === 'number' ? cost.toLocaleString('en-US') : '?'} iron) — use-on: ${describeSlots(augment.allowedSlots)} — ${lines.join('; ')}`,
      );
    }
  }
  if (groups.length === 0) out.line('\nNo faction vendor this character has unlocked stocks a level-appropriate augment.');
}

/** Where a loose socketable can sit, said the way the window names the container. */
const SOURCE_PLACE: Record<string, string> = {
  inventory: 'in your bags',
  stash: 'in the personal stash',
  transfer: 'in the transfer stash',
  materials: 'in the materials store',
};

/**
 * Where to obtain each socketable the document knows, as prose lines by record.
 *
 * A *proposed* component or augment is installed nowhere, so "where does it
 * come from" is the first practical question its tooltip has to answer — and
 * every answer already exists in this module's derivations: the loose tally and
 * the installed hosts (§8's census), the craft plan (§8/§10's recipe view) and
 * the faction stock (§9). This is those four, keyed by record for the UI
 * snapshot to attach to `UiSocketable.obtain`; the sections keep their own
 * renderings.
 *
 * Order is the sourcing order the prompt teaches: on hand, then craft, then
 * buy — and the only-installed warning last, exactly when no other source
 * exists, because that is when extraction (which destroys the host) becomes
 * the actual proposal.
 */
export function socketableObtain(input: ContextInput, recipes: RecipeView = recipeView(input)): Map<string, string[]> {
  const { save, db, aggregate, resolved } = input;

  const loose = new Map<string, Map<string, number>>();
  const hosts = new Map<string, string[]>();
  const installedAugments = new Set<string>();
  for (const item of resolved.items) {
    if (item.base && (item.base.slot === COMPONENT_CLASS || item.base.slot === AUGMENT_CLASS)) {
      const bySource = loose.get(item.base.record) ?? new Map<string, number>();
      bySource.set(item.source, (bySource.get(item.source) ?? 0) + Math.max(1, item.stackCount));
      loose.set(item.base.record, bySource);
    }
    if (item.component) {
      const list = hosts.get(item.component.record) ?? [];
      list.push(`${item.display} (${item.location})`);
      hosts.set(item.component.record, list);
    }
    if (item.augment) installedAugments.add(item.augment.record);
  }

  const craft = new Map<string, string>();
  for (const recipe of recipes.relevant) {
    const result = recipe.resultRecord ? db.getItem(recipe.resultRecord) : undefined;
    if (result?.slot !== COMPONENT_CLASS || craft.has(result.record)) continue;
    const plan = recipes.planFor(recipe);
    const reagents = [...(recipe.baseReagent ? [recipe.baseReagent] : []), ...recipe.reagents]
      .map((r) => `${r.quantity}× ${r.name ?? r.record}`)
      .join(', ');
    craft.set(
      result.record,
      plan.missing.length
        ? `${recipe.alwaysKnown ? 'Any blacksmith crafts it, but' : 'Blueprint learned but'} not craftable yet — missing ${plan.missing.join(', ')}`
        : `Craftable now from ${reagents}, ${plan.ironTotal.toLocaleString('en-US')} iron${
            plan.prerequisites.length ? `, after first crafting ${plan.prerequisites.join(', ')}` : ''
          }`,
    );
  }

  const buy = new Map<string, string>();
  for (const stock of vendorStock(save, db, aggregate.level)) {
    for (const augment of stock.augments) {
      if (buy.has(augment.record)) continue;
      const at = augment.vendors?.find((v) => v.factionId === stock.factionId)?.repTier ?? stock.tier;
      const cost = augment.stats['itemCost'];
      buy.set(
        augment.record,
        `Buy: ${stock.factionName} (${at}), ${typeof cost === 'number' ? cost.toLocaleString('en-US') : '?'} iron`,
      );
    }
  }

  // The tier actually reached per unlocked faction, for the one negative answer
  // worth giving: a vendor augment whose faction the character has not stood
  // high enough with yet.
  const reached = new Map<string, string>();
  for (const rep of save.factions) {
    if (!rep.unlocked) continue;
    const slot = factionSlot(rep.id);
    if (slot) reached.set(slot.id, factionTier(rep.value));
  }

  const records = new Set([...loose.keys(), ...hosts.keys(), ...craft.keys(), ...buy.keys(), ...installedAugments]);
  const out = new Map<string, string[]>();
  for (const record of records) {
    const lines: string[] = [];
    const bySource = loose.get(record);
    if (bySource) {
      lines.push(`On hand: ${[...bySource].map(([s, n]) => `${n}× ${SOURCE_PLACE[s] ?? s}`).join(', ')}`);
    }
    const crafted = craft.get(record);
    if (crafted) lines.push(crafted);
    const bought = buy.get(record);
    if (bought) lines.push(bought);
    else if (!bySource && !crafted) {
      const vendor = db.getItem(record)?.vendors?.[0];
      if (vendor) {
        const faction = db.factions().find((f) => f.id === vendor.factionId)?.name ?? vendor.factionId;
        const standing = reached.get(vendor.factionId);
        lines.push(
          `Sold by ${faction} at ${vendor.repTier} reputation — not reached yet${standing ? ` (currently ${standing})` : ''}`,
        );
      }
    }
    const inside = hosts.get(record);
    if (inside && lines.length === 0) {
      lines.push(
        `The only ${inside.length === 1 ? 'copy is' : 'copies are'} installed in ${inside.join(', ')} — extraction destroys the host item`,
      );
    }
    if (lines.length) out.set(record, lines);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 10 — blueprints and upgrade paths
// ---------------------------------------------------------------------------

/**
 * The learned blueprints worth listing, with the materials check that decides
 * whether each is craftable now.
 *
 * Scope is **components and relics only** (`ItemRelic` / `ItemArtifact`).
 * Craftable armour and weapons are noise: §7 already ranks every candidate the
 * character owns for those slots against their actual build, and a crafted
 * base-stat piece cannot be compared to a rolled one from this data. Relics are
 * not optional — one of `_Suchka`'s three dual-wield enablers is a relic.
 */
const CRAFTABLE_RESULT_CLASSES = new Set([COMPONENT_CLASS, 'ItemArtifact']);

/**
 * What it would take to craft one recipe, following the chain.
 *
 * A component recipe's reagents are often *other components*, and the character
 * may hold the blueprint for the missing one. Reporting "missing Ballistic
 * Plating 0/4" when four are two clicks away is a false negative that costs the
 * advisor a real move, so the resolver crafts what it can and reports what is
 * left. Materials are drawn from one shared pool as it descends, which is what
 * stops a sub-craft and its parent spending the same Ugdenbloom twice.
 */
interface CraftPlan {
  /** Reagent shortfalls no learned blueprint closes, as `name have/need`. */
  missing: string[];
  /** Sub-crafts to do first, deepest-first, as `4× Ballistic Plating`. */
  prerequisites: string[];
  /** Iron for this craft plus every prerequisite. */
  ironTotal: number;
  /** True when iron is the only thing missing. */
  shortOfIron: boolean;
}

/** How deep the reagent chain is followed. Real component chains are 1–2 deep. */
const MAX_CRAFT_DEPTH = 4;

/**
 * Collapse `1× Ectoplasm, 1× Ectoplasm, 3× Vengeful Wraith` into
 * `2× Ectoplasm, 3× Vengeful Wraith`. The resolver crafts a shortfall one at a
 * time — each pass spends from the same pool, which is what makes the count
 * honest — so the raw list repeats a deeper prerequisite once per pass.
 */
function mergeCounts(entries: readonly string[]): string[] {
  const totals = new Map<string, number>();
  for (const entry of entries) {
    const [, count, label] = /^(\d+)× (.+)$/.exec(entry) ?? [];
    if (label === undefined) continue;
    totals.set(label, (totals.get(label) ?? 0) + Number(count));
  }
  return [...totals].map(([label, count]) => `${count}× ${label}`);
}

interface RecipeView {
  /** Blueprints the character has learned whose result is in scope. */
  relevant: DbRecipe[];
  /** Of those, the ones needing nothing but iron already on hand. */
  craftable: DbRecipe[];
  /** Craftable only after crafting a prerequisite the character can also make. */
  craftableAfterChain: DbRecipe[];
  /** The full resolution for one recipe, prerequisites included. */
  planFor(recipe: DbRecipe): CraftPlan;
  /** Craftable blueprint record paths: learned, plus every smith's defaults. */
  known: Set<string>;
  /** Record path → count, pooled across every container the character can reach. */
  onHand: Map<string, number>;
}

function recipeView(input: ContextInput): RecipeView {
  const { db, save, resolved, aggregate } = input;

  // What the account can actually consume, pooled across every container —
  // including the reagent store, which is where the materials really live.
  const onHand = new Map<string, number>();
  for (const item of resolved.items) {
    onHand.set(item.record, (onHand.get(item.record) ?? 0) + Math.max(1, item.stackCount));
  }

  // Learned blueprints, plus the ones every blacksmith offers unlearned — the
  // crafting panel's own default list (base components, the starter relics).
  // Without the second half, a chain like Runestone = 3× Aether Crystal +
  // 3× Wardstone reports "missing Wardstone" against a Wardstone any smith
  // will make from materials on hand.
  const known = new Set(resolved.recipes.map((r) => r.record));
  for (const recipe of db.recipes()) if (recipe.alwaysKnown) known.add(recipe.record);
  const byRecord = new Map(db.recipes().map((r) => [r.record, r]));

  // Learned blueprints indexed by what they *produce*, so a missing reagent can
  // be looked up as something the character might simply make.
  const makes = new Map<string, DbRecipe>();
  for (const record of known) {
    const recipe = byRecord.get(record);
    if (recipe?.resultRecord && !makes.has(recipe.resultRecord)) makes.set(recipe.resultRecord, recipe);
  }

  const reagentsOf = (recipe: DbRecipe): { record: string; name?: string; quantity: number }[] => [
    ...(recipe.baseReagent ? [recipe.baseReagent] : []),
    ...recipe.reagents,
  ];

  /**
   * Draw one recipe's needs out of `pool`, crafting sub-recipes where the pool
   * falls short. `building` breaks a reagent cycle; the depth cap is the
   * backstop for a chain the data may grow later.
   */
  function resolve(
    recipe: DbRecipe,
    pool: Map<string, number>,
    building: Set<string>,
    depth: number,
    out: { missing: string[]; prerequisites: string[]; iron: number },
  ): void {
    out.iron += recipe.ironCost ?? 0;
    for (const reagent of reagentsOf(recipe)) {
      const have = pool.get(reagent.record) ?? 0;
      const taken = Math.min(have, reagent.quantity);
      pool.set(reagent.record, have - taken);
      let short = reagent.quantity - taken;
      if (short <= 0) continue;

      const sub = makes.get(reagent.record);
      const label = reagent.name ?? reagent.record;
      if (!sub || depth >= MAX_CRAFT_DEPTH || building.has(reagent.record)) {
        out.missing.push(`${label} ${have}/${reagent.quantity}`);
        continue;
      }

      // Craft the shortfall one at a time: each pass spends from the same pool,
      // so a chain that runs the shared materials dry says so instead of
      // pretending the first success repeats.
      building.add(reagent.record);
      let made = 0;
      for (; short > 0; short--) {
        const attempt = { missing: [] as string[], prerequisites: [] as string[], iron: 0 };
        const snapshot = new Map(pool);
        resolve(sub, pool, building, depth + 1, attempt);
        if (attempt.missing.length) {
          // Roll back the partial spend; this one could not be made.
          pool.clear();
          for (const [k, v] of snapshot) pool.set(k, v);
          break;
        }
        out.prerequisites.push(...attempt.prerequisites);
        out.iron += attempt.iron;
        made++;
      }
      building.delete(reagent.record);
      if (made > 0) out.prerequisites.push(`${made}× ${label}`);
      if (short > 0) out.missing.push(`${label} ${have + made}/${reagent.quantity}`);
    }
  }

  const planFor = (recipe: DbRecipe): CraftPlan => {
    const out = { missing: [] as string[], prerequisites: [] as string[], iron: 0 };
    resolve(recipe, new Map(onHand), new Set(), 0, out);
    const shortOfIron = out.missing.length === 0 && out.iron > save.iron;
    if (shortOfIron) {
      out.missing.push(`iron ${save.iron.toLocaleString('en-US')}/${out.iron.toLocaleString('en-US')}`);
    }
    return { missing: out.missing, prerequisites: mergeCounts(out.prerequisites), ironTotal: out.iron, shortOfIron };
  };

  const relevant = [...known]
    .map((record) => byRecord.get(record))
    .filter((recipe): recipe is DbRecipe => Boolean(recipe))
    .filter((recipe) => {
      const result = recipe.resultRecord ? db.getItem(recipe.resultRecord) : undefined;
      if (!result) return false;
      // Materials and consumables are means, not ends.
      if (result.record.startsWith(MATERIAL_PREFIX)) return false;
      if (!CRAFTABLE_RESULT_CLASSES.has(result.slot)) return false;
      // An over-level result is unusable; an under-level one is not. A
      // component's value does not decay with the character's level the way a
      // piece of gear's does, so only the ceiling applies here.
      return result.levelReq <= aggregate.level + 10;
    })
    .sort((a, b) => (db.getItem(b.resultRecord ?? '')?.levelReq ?? 0) - (db.getItem(a.resultRecord ?? '')?.levelReq ?? 0));

  const plans = new Map(relevant.map((r) => [r.record, planFor(r)]));
  return {
    relevant,
    craftable: relevant.filter((r) => {
      const plan = plans.get(r.record)!;
      return plan.missing.length === 0 && plan.prerequisites.length === 0;
    }),
    craftableAfterChain: relevant.filter((r) => {
      const plan = plans.get(r.record)!;
      return plan.missing.length === 0 && plan.prerequisites.length > 0;
    }),
    planFor: (recipe) => plans.get(recipe.record) ?? planFor(recipe),
    known,
    onHand,
  };
}

function blueprints(out: Writer, ctx: RenderContext, selection: CandidateSelection, trim: Trim): void {
  const { db, save, resolved, aggregate } = ctx;
  const { relevant, planFor, known } = ctx.recipes;

  // Components are craftable *and* ownable, so they live with the rest of the
  // component supply in §8. What is left here is relics — which are gear, and
  // compete in §7's Relic slot — plus the purchase and awakening paths.
  const relics = relevant.filter((r) => {
    const result = r.resultRecord ? db.getItem(r.resultRecord) : undefined;
    return result !== undefined && result.slot !== COMPONENT_CLASS;
  });
  const craftableNow = relics.filter((r) => planFor(r).missing.length === 0);

  out.h(2, '10. Craftable relics, blueprints on sale, and upgrade paths');
  out.line(
    `Learned blueprints: ${resolved.recipes.length}. **Craftable components are in §8 with the rest of the component supply**, and craftable armour and weapons are omitted entirely — §7 already ranks everything this character owns for those slots. ` +
      `What is left here is relics: ${relics.length} in the level window, **${craftableNow.length} craftable right now**. Reagent chains are resolved, so a "missing" reagent really is missing — a prerequisite the character can craft is named instead.`,
  );

  const line = (recipe: DbRecipe): string => {
    const plan = planFor(recipe);
    const reagents = [...(recipe.baseReagent ? [recipe.baseReagent] : []), ...recipe.reagents]
      .map((r) => `${r.quantity}× ${r.name ?? r.record}`)
      .join(', ');
    const result = recipe.resultRecord ? db.getItem(recipe.resultRecord) : undefined;
    const cost = plan.prerequisites.length
      ? `${plan.ironTotal.toLocaleString('en-US')} iron incl. prerequisites`
      : `${(recipe.ironCost ?? 0).toLocaleString('en-US')} iron`;
    const verdict = plan.missing.length
      ? `missing ${plan.missing.join(', ')}`
      : plan.prerequisites.length
        ? `**craftable now**, after first crafting ${plan.prerequisites.join(', ')}`
        : '**craftable now**';
    const stats = result ? formatStats(result.stats, { db, invested: ctx.invested }) : [];
    return (
      `- **${recipe.resultName ?? recipe.name}** (lvl ${result?.levelReq ?? '?'}) — ${reagents || 'no reagents'}, ${cost} — ${verdict}` +
      (stats.length ? `\n  - ${stats.join('; ')}` : '')
    );
  };

  if (trim.compressRecipes) {
    out.line();
    out.bullets(craftableNow.slice(0, 15).map((r) => `**${r.resultName ?? r.name}** — craftable now (${planFor(r).ironTotal.toLocaleString('en-US')} iron)`));
    if (craftableNow.length > 15) out.line(`- … and ${craftableNow.length - 15} more craftable now`);
  } else {
    out.line();
    for (const recipe of relics) out.line(line(recipe));
  }

  // Blueprints on sale that the character has not learned yet.
  const purchasable: string[] = [];
  for (const rep of save.factions) {
    if (!rep.unlocked) continue;
    const slot = factionSlot(rep.id);
    const faction = slot ? db.factions().find((f) => f.id === slot.id) : undefined;
    if (!slot || !faction?.hasVendor) continue;
    const reached = tiersUpTo(factionTier(rep.value));
    if (!reached.length) continue;
    for (const item of db.vendorItems(slot.id, reached.at(-1)!)) {
      if (item.slot !== 'ItemArtifactFormula' || known.has(item.record)) continue;
      if (item.levelReq > aggregate.level + 10) continue;
      purchasable.push(`**${item.name}** — purchasable at ${faction.name} (${item.vendors?.find((v) => v.factionId === slot.id)?.repTier ?? ''})`);
    }
  }
  if (purchasable.length) {
    out.line();
    out.line('**Blueprints on sale that are not learned yet:**');
    out.bullets(purchasable.slice(0, 20));
    if (purchasable.length > 20) out.line(`- … and ${purchasable.length - 20} more`);
  }

  // Awakening: any equipped or candidate item that is the base of an upgrade.
  const upgradeOf = new Map<string, DbRecipe[]>();
  for (const recipe of db.recipes()) {
    const base = recipe.baseReagent?.record;
    if (!base) continue;
    upgradeOf.set(base, [...(upgradeOf.get(base) ?? []), recipe]);
  }
  const interesting = [...ctx.equipped, ...[...selection.byGroup.values()].flat().map((c) => c.item)];
  const notes = new Set<string>();
  for (const item of interesting) {
    for (const recipe of upgradeOf.get(item.record) ?? []) {
      const reagents = [...(recipe.baseReagent ? [recipe.baseReagent] : []), ...recipe.reagents]
        .map((r) => `${r.quantity}× ${r.name ?? r.record}`)
        .join(' + ');
      const plan = planFor(recipe);
      notes.add(
        `**${item.display}** upgrades to **${recipe.resultName ?? recipe.name}** — ${reagents}, ${(recipe.ironCost ?? 0).toLocaleString('en-US')} iron` +
          (known.has(recipe.record) ? '' : ' *(blueprint not learned)*') +
          (plan.missing.length
            ? ` — missing ${plan.missing.join(', ')}`
            : plan.prerequisites.length
              ? ` — **all reagents reachable**, after first crafting ${plan.prerequisites.join(', ')}`
              : ' — **all reagents on hand**'),
      );
    }
  }
  if (notes.size) {
    out.line();
    out.line('**An awakened / upgraded version exists** — a strong reason to HOLD the base item even when the upgrade is currently unaffordable:');
    out.bullets([...notes]);
  }

  out.line();
  out.line('**Ascension** (Ascendant Altar, gdx3) exists as well: it rolls a *random* ascended affix onto an item for five material types plus 250,000 iron, with further reroll costs. It is a gamble, not a plan — mention it if an item is worth the risk, never prescribe rerolling.');
}

// ---------------------------------------------------------------------------
// 11 — the task
// ---------------------------------------------------------------------------

function task(out: Writer, ctx: RenderContext): void {
  out.h(2, '11. Task');
  out.line(`You are advising **${ctx.save.name}** on gear. Everything you need is above; do not rely on remembered Grim Dawn knowledge that conflicts with §2.`);
  out.line();
  out.line('Optimise the loadout **as a whole** — gear, components and augments assigned together — not slot by slot. A component or augment freed by one change is available to another.');
  out.line();
  out.line('For every equipment slot, give exactly one of:');
  out.bullets([
    '`KEEP` — with the reason it beats the listed alternatives, and the number; name a candidate whose §7 line says `closable`',
    '`EQUIP <item id>` — the candidate to wear instead',
    '`RE-AUGMENT <augment name>` — replace the augment (cheap: only the new augment costs anything)',
    '`ADD-COMPONENT <component name>` — fill an empty component socket (free)',
    '`SWAP-COMPONENT <component name>` — replace an installed component (destroys the old one, costs an iron fee, and removes the augment)',
    '`BUY-AUGMENT <augment name>` — from a faction in §9, within the iron on hand',
    '`CRAFT <blueprint>` — only when §10 marks it craftable now, or says exactly what is missing; a component going into a socket is ADD-/SWAP-COMPONENT',
  ]);
  out.line();
  out.line('Then give:');
  out.bullets([
    'a **HOLD** list — items to keep for a stated condition, naming it: a level, attribute points, or the *kind* of drop that would cover what putting the item on opens today (a swap the loadout cannot absorb yet is a hold with a condition, not a sell; a drop hold is for a §7 line that says `not closable`). Each hold names its slot, the item it would replace, what it gains, and until when',
    'a **SELL/SALVAGE** line — a count and the kinds, for items no plausible version of this build reaches; the items themselves belong in the plan\'s `sell` array rather than in a prose bullet each',
    'the reasoning behind each non-obvious call, in one or two sentences',
  ]);
  out.line();
  out.line('Finally, a **projected "after" summary** — the same numbers §3, §4 and §5 report now, restated for the recommended loadout, so the cost of every gain is visible:');
  out.bullets([
    'the **resistances** — tally the post-change figures in the JSON `projectedResistances` and state the cap outcomes in prose sentences; do **not** write a prose resistance table, the tool computes the real before→after from your verdicts and renders it. `projectedResistances` and any figure you call **effective** mean §3\'s definition — with maintainable buffs, after the difficulty penalty. A permanent-only reading ("the buff is pure overcap buffer") is an argument to make in `projected.notes`, stated as such, never a silent relabel of the effective row',
    'the **armour** figure for the weakest body part and the hit-weighted mean, since a swap moves one part at a time',
    '**health**, **Offensive Ability** and **Defensive Ability** deltas (as contributions — the engine base is not modelled)',
    '**Physique / Cunning / Spirit** totals, and a confirmation that every item in the projected loadout still meets its requirements *after* the outgoing items\' `+Attribute` and `-% Requirement` bonuses are gone',
    'the **damage profile**, qualitatively: what happens to the build-focus types\' `+%` totals and flat pools, and to the weapon-attack composition. Do **not** recompute per-skill damage figures — §4 states them rank by rank; read a moved skill off those columns',
    'the **enemy resistance-reduction list** restated when a change adds, removes or re-ranks an RR source — RR multiplies on-type damage, and within the flat and percent-reduced categories only the strongest source counts',
    '**skill ranks that move** — a swap that changes `+N to <skill>` shifts every stat read at that rank, including resistances already counted above; attack skills, RR skills and moving-stat buffs have their moved stats in §4\'s rank-by-rank tables, so read them there rather than estimating',
    '**attack, casting and movement speed** restated against their caps, using §3\'s figures and headroom — attack speed multiplies all damage throughput, so a swap that moves it has a damage consequence that the §4 profile does not show',
    'anything pushed **past a cap** — speed past the §3 ceilings, or a resistance past its §2 overcap target (both are wasted stats, not gains)',
  ]);
  out.line();
  out.line('Give the projection as concrete numbers where §3–§5 gave numbers, and say plainly when a figure cannot be derived from this document instead of estimating it silently.');
  out.line();
  out.line(
    'Trading some damage for a capped resistance is normal; a plan that costs on the order of a third of the build\'s primary `+%` damage pool is not, unless the resistances it buys are otherwise broken. ' +
      (ridesWeaponAttacks(ctx.aggregate.damage)
        ? '§4\'s **weapon payload index** is the yardstick: state the plan\'s index delta as a percentage — low single digits spent on a genuinely under-cap resistance is normal, tens of percent needs the resistance case spelled out.'
        : 'This build\'s damage does not ride weapon attacks, so §4\'s weapon payload index prices only a minor channel — the yardstick here is the build-focus types\' `+%` damage pools: state the plan\'s damage cost against those columns, and quote the index delta only as the secondary figure it is.'),
  );
  out.line();
  out.line('Then a **Next levels** section, ordered cheapest-first, from the costed thresholds in §12 — but **only those worth committing to**: what to spend and which held items it buys, dismissing a competing rung in a clause rather than a row of its own. Attribute points and farming targets are in scope; skill and devotion trees are not.');
  out.line();
  out.line('Hard constraints:');
  out.bullets([
    'never propose a socketable for a slot its use-on restriction rejects',
    'never propose a swap that leaves the character unable to meet an item\'s requirements once the outgoing item\'s bonuses and reductions are gone — re-check the whole post-swap loadout',
    'never remove the last dual-wield enabler while leaving two one-handed weapons equipped',
    'never propose moving or trading an item that is soulbound by an applied augment',
    'never count `+% speed` past the caps in §2, and never count a resistance past its §2 overcap target as a gain',
    'state when a recommendation depends on something §3 lists as not counted',
  ]);
}

// ---------------------------------------------------------------------------
// 12 — the unlock ladder
// ---------------------------------------------------------------------------

/** One threshold, and everything that clears when it is met. */
interface Rung {
  /** Sort key: levels for a level rung, points for an attribute rung. */
  cost: number;
  heading: string;
  attr?: AttrKey;
  /** Attribute rungs only — how many unspent points this rung costs. */
  points?: number;
  items: { id: string; candidate: Candidate; also?: string }[];
}

/** How many stat lines a ladder entry shows before it is cut off. */
const LADDER_STAT_LINES = 4;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * What the next levels and attribute points actually buy.
 *
 * The HOLD data already knows every threshold, but as one free-text row per
 * item: twelve unordered lines in which the single most actionable fact — that
 * nine of them clear at the same level, two away — is something the reader has
 * to notice for themselves. Grouping makes it structural, and the arithmetic
 * (`ceil(deficit / attribute-per-point)`, both figures read from the game's own
 * level table) turns "short 24 spirit" into "spend your next 3 points on
 * Spirit", which is a move rather than an observation.
 *
 * The builder emits the ladder; the advisor decides what is worth buying. That
 * is the same seam `checkRequirements` draws by reporting rather than filtering.
 */
function unlockLadder(out: Writer, ctx: RenderContext, selection: CandidateSelection): void {
  const { aggregate, db } = ctx;
  const lp = db.levelProgression();
  const blocked = [...selection.byGroup.values()].flat().filter((c) => !c.check.meets && c.check.gaps.length);

  out.h(2, '12. Unlock ladder — what the next levels and attribute points buy');

  if (blocked.length === 0) {
    out.line('Every candidate in §7 already meets its requirements. Nothing is waiting on a level or an attribute point.');
    return;
  }

  // Cost is reported in the currency it is actually paid in. Levels and points
  // are *not* interconverted in the prose even though the game's level table
  // states the rate (1 attribute point per level) — a level also costs XP, and
  // the two are different things to spend.
  const pointsFor = (attr: AttrKey, deficit: number): number =>
    Math.ceil(deficit / (lp.attributePerPoint[attr] || 1));

  const rungs = new Map<string, Rung>();
  const rung = (key: string, make: () => Rung): Rung => {
    const existing = rungs.get(key) ?? make();
    rungs.set(key, existing);
    return existing;
  };

  for (const candidate of blocked) {
    const id = ctx.ids.get(candidate.item) ?? candidate.item.id;
    const others = (self: RequirementGap): string | undefined => {
      const rest = candidate.check.gaps.filter((g) => g !== self);
      if (!rest.length) return undefined;
      return `also needs ${rest
        .map((g) => (g.attr === 'level' ? `level ${g.need}` : `${plural(pointsFor(g.attr, g.deficit), 'point')} into ${ATTR_LABEL[g.attr]}`))
        .join(' and ')}`;
    };

    for (const gap of candidate.check.gaps) {
      const also = others(gap);
      const item = { id, candidate, ...(also ? { also } : {}) };
      if (gap.attr === 'level') {
        const away = gap.need - aggregate.level;
        const key = `level:${gap.need}`;
        const target = rung(key, () => ({
          cost: away,
          heading: `At level ${gap.need} (${away === 1 ? '1 level' : `${away} levels`} away)`,
          items: [],
        }));
        target.items.push(item);
      } else {
        const points = pointsFor(gap.attr, gap.deficit);
        const key = `${gap.attr}:${points}`;
        const label = ATTR_LABEL[gap.attr];
        const target = rung(key, () => ({
          cost: points,
          attr: gap.attr as AttrKey,
          points,
          heading:
            `${plural(points, 'attribute point')} into ${label} ` +
            `(${points * lp.attributePerPoint[gap.attr as AttrKey]} ${label}: ${Math.round(gap.have)} → ${Math.round(gap.have) + points * lp.attributePerPoint[gap.attr as AttrKey]})`,
          items: [],
        }));
        target.items.push(item);
      }
    }
  }

  const ordered = [...rungs.values()].sort((a, b) => a.cost - b.cost || b.items.length - a.items.length);
  const biggest = [...ordered].sort((a, b) => b.items.length - a.items.length)[0]!;

  out.line(
    `${plural(blocked.length, 'candidate')} in §7 fail a requirement. They are grouped below by the **threshold they share**, cheapest first, so a single purchase can be weighed against everything it unlocks at once — ` +
      `the largest group is "${biggest.heading}", which alone unlocks ${biggest.items.length}. ` +
      `Unspent now: **${plural(aggregate.attributes.unspentPoints, 'attribute point')}**. One point is ${lp.attributePerPoint.physique} Physique / ${lp.attributePerPoint.cunning} Cunning / ${lp.attributePerPoint.spirit} Spirit, and each level grants ${lp.attributePointsPerLevel} (both from the game's level table). ` +
      `An item with two gaps appears under both and says so — it unlocks only when **all** of them are met. ` +
      `A **costing table, not a to-do list**: a rung earns a "Next levels" line only where something you hold hangs off it.`,
  );

  for (const entry of ordered) {
    out.line();
    out.line(`### ${entry.heading} — ${plural(entry.items.length, 'item')} unlock${entry.items.length === 1 ? 's' : ''}`);
    for (const { id, candidate, also } of entry.items) {
      const bits = [
        candidate.covers.length ? `covers ${candidate.covers.join(', ')}` : '',
        ladderStats(candidate, ctx),
        also,
      ].filter(Boolean);
      out.line(`- **${candidate.item.display}** \`#${id}\` (${candidate.group}) — ${bits.join('; ')}`);
    }
  }

  attributeBudget(out, ordered, aggregate.attributes.unspentPoints);
}

const ATTR_LABEL: Readonly<Record<AttrKey, string>> = {
  physique: 'Physique',
  cunning: 'Cunning',
  spirit: 'Spirit',
};

function ladderStats(candidate: Candidate, ctx: RenderContext): string {
  const merged: Record<string, number | string> = {};
  for (const stats of itemStatBlocks(candidate.item)) Object.assign(merged, stats);
  const lines = formatStats(merged, { db: ctx.db, invested: ctx.invested });
  if (lines.length === 0) return '';
  const shown = lines.slice(0, LADDER_STAT_LINES).join('; ');
  return lines.length > LADDER_STAT_LINES ? `${shown}; … (full entry in §7)` : shown;
}

/**
 * Attribute points are one decision, not one per item.
 *
 * Points are near-permanent (§2: the Tonic of Reshaping is scarce), so the
 * advisor has to pick a line rather than satisfy every held item. Totalling the
 * competing demands per attribute is what makes that choice visible: "3 into
 * Spirit unlocks 1" against "3 into Physique unlocks 2" is a comparison; twelve
 * separate per-item deficits are not.
 */
function attributeBudget(out: Writer, rungs: readonly Rung[], unspent: number): void {
  const byAttr = new Map<AttrKey, Map<number, number>>();
  for (const rung of rungs) {
    if (!rung.attr || rung.points === undefined) continue;
    const tiers = byAttr.get(rung.attr) ?? new Map<number, number>();
    tiers.set(rung.points, (tiers.get(rung.points) ?? 0) + rung.items.length);
    byAttr.set(rung.attr, tiers);
  }
  if (byAttr.size === 0) return;

  out.line();
  out.line(
    '**Attribute allocation is one decision.** Points are near-permanent (§2 — the Tonic of Reshaping is scarce), ' +
      `so this is a line to commit to, not a per-item fix. ${plural(unspent, 'point')} unspent right now. Cumulative, per attribute:`,
  );
  const rows: string[] = [];
  for (const [attr, tiers] of byAttr) {
    let running = 0;
    const steps = [...tiers.keys()]
      .sort((a, b) => a - b)
      .map((points) => {
        running += tiers.get(points) ?? 0;
        return `${plural(points, 'point')} unlocks ${running}`;
      });
    rows.push(`**${ATTR_LABEL[attr]}**: ${steps.join('; ')}`);
  }
  out.bullets(rows);
}
