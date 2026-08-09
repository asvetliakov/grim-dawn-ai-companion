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

import type { DbItem, DbRecipe, DbSet, DbSkill, GameDb, RepTier, StatValue } from '../db/types.js';
import { REP_TIERS } from '../db/types.js';
import type { CharacterAggregate, DualWieldEnabler, MatrixRow } from '../mechanics/aggregate.js';
import type { CharacterStanding, RequirementCheck, RequirementGap } from '../mechanics/requirements.js';
import { atRank, modifierParent, skillLabel, statRecord } from '../mechanics/skills.js';
import {
  addDamage,
  ATTR_KEYS,
  DAMAGE_TYPES,
  emptyDamage,
  RESIST_COLUMNS,
  type AttrKey,
  type DamageKey,
  type ResistKey,
  type ResistVector,
} from '../mechanics/stats.js';
import { shortHash, type ResolvedCharacter, type ResolvedItem } from '../resolve.js';
import { factionSlot, factionTier } from '../save/factions.js';
import { EQUIP_SLOT_NAMES, type CharacterSave } from '../save/types.js';
import {
  estimateTokens,
  EQUIP_GROUPS,
  itemStatBlocks,
  selectCandidates,
  type Candidate,
  type CandidateSelection,
} from './filters.js';
import { describeSlots, formatStats, num, signed } from './statfmt.js';

export interface ContextInput {
  save: CharacterSave;
  /** Aggregates for the difficulty the document is being written for. */
  aggregate: CharacterAggregate;
  /** Everything the character can reach, plus the account's blueprints. */
  resolved: ResolvedCharacter;
  db: GameDb;
}

export interface ContextOptions {
  /** Token ceiling; the builder tightens candidate caps until it fits. */
  maxTokens?: number;
  /** Candidates per equipment group before tightening. */
  perGroup?: number;
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
  const ladder: Trim[] = [
    ...CAP_LADDER.filter((cap) => cap < startCap).map((cap) => ({
      perGroup: cap,
      note: `candidates capped at ${cap} per slot`,
    })),
    { perGroup: tightest, compressRecipes: true, note: 'blueprint section compressed to counts' },
    { perGroup: tightest, compressRecipes: true, compressCensus: true, note: 'component census compressed to counts' },
  ];

  const trimmed: string[] = [];
  let doc = render(input, { perGroup: startCap, note: 'nothing trimmed' });
  for (const step of ladder) {
    if (estimateTokens(doc) <= maxTokens) break;
    doc = render(input, step);
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
    markdown: doc,
    tokenEstimate: estimateTokens(doc),
    trimmed,
    itemIds: new Map([...itemsById].map(([id, item]) => [id, item.display])),
    itemsById,
    socketablesById,
  };
}

interface Trim {
  perGroup: number;
  compressRecipes?: boolean;
  compressCensus?: boolean;
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

function render(input: ContextInput, trim: Trim): string {
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
    equipped,
    invested,
    recipes,
    iron: ironOutlook(input, recipes),
  };

  header(out, ctx);
  gameRules(out, ctx);
  attributesAndDefenses(out, ctx);
  buildProfile(out, ctx);
  equippedSection(out, ctx);
  const selection = candidateSelection(ctx, trim.perGroup);
  setStatus(out, ctx);
  candidatesSection(out, ctx, selection);
  census(out, ctx, selection, trim);
  factionAugments(out, ctx);
  blueprints(out, ctx, selection, trim);
  task(out, ctx);
  unlockLadder(out, ctx, selection);

  return out.toString();
}

interface RenderContext extends ContextInput {
  ids: Map<ResolvedItem, string>;
  /** Component/augment record path → its dossier id. */
  socketableIds: Map<string, string>;
  equipped: ResolvedItem[];
  /** Skill records with at least one invested point. */
  invested: Set<string>;
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

function gameRules(out: Writer, ctx: RenderContext): void {
  const { aggregate, db } = ctx;
  const caps = db.speedCaps();
  const penalty = RESIST_COLUMNS.map((c) => `${c.label} ${num(aggregate.resistances.penalty[c.key] ?? 0)}`).join(' · ');

  out.h(2, '2. Game rules (v1.3, Fangs of Asterkarn — do not substitute older knowledge)');

  out.line('**Resistances.** Each of the ten damage resistances caps at 80%. `+% Maximum X Resistance` raises that cap, to a hard ceiling of 95%. The difficulty penalty is subtracted from the total *before* the cap, and it is **not uniform** — the in-game "−25%/−50% to all resistances" blurb is a simplification. On this character\'s difficulty the penalty **to each resistance** is:');
  out.line();
  out.line(`> ${aggregate.difficulty}: ${penalty}`);
  out.line();
  out.line('Enemies in the late game carry resistance reduction of their own, so the community target is **+20 to +30 overcap** on the resistances a build actually faces, not exactly 80. Being under cap on a resistance the character meets constantly is the single most common cause of death.');

  out.line();
  out.line('**Armour is localized, not pooled.** Every physical hit rolls one body part — Head 12%, Shoulders 12%, Chest 24%, Hands 16%, Legs 20%, Feet 16% — and is met by *that piece alone*. Summing six ratings describes a character who does not exist. Flat `+Armor` from rings, components and skills is added to **every** part. Absorption is multiplicative on a 70% base: `+20% Armor Absorption` gives 84%, not 90%, and it caps at 100%.');

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
  out.line('**Granted skills.** Wherever an item, component or augment reads `Grants: <skill>`, the skill\'s own stats follow it and the parenthetical says **how you get them**: `passive — always on` (simply true), `toggle` (true while held, at the energy reservation shown in its stats), `activated` (you have to cast it), `auto-cast <trigger>` (a proc — a chance per trigger, not a constant), or `weapon-pool proc` (a share of basic attacks). None of these is summed into §3; they are named and shown so you can weigh them yourself, and §3 lists them as an exclusion.');

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
 * What the three attributes buy beyond wearing gear.
 *
 * Stated because §4's damage profile does *not* include it, and an advisor with
 * no note here has two bad options: ignore a real term, or invent a coefficient.
 * The types come from the game's own attribute descriptions
 * (`tagCharAttributeDescription01`/`02`/`03`); the *rate* is engine-side and
 * appears in no record, exactly like the armour hit weights — so the size is
 * declared underivable rather than guessed.
 */
function attributeScaling(out: Writer, ctx: RenderContext): void {
  const a = ctx.aggregate.attributes;
  out.line();
  out.line('**What the attributes themselves scale** (the game\'s own attribute descriptions; *not* included in §4\'s damage profile):');
  out.bullets([
    '**Cunning** — Physical, Pierce, Bleeding and Internal Trauma **Damage**, plus Offensive Ability, critical hits and health.',
    '**Spirit** — the magical damage types (Fire, Cold, Lightning, Aether, Chaos, Vitality **Damage** and their damage-over-time twins), plus energy and energy regeneration.',
    '**Physique** — health, health regeneration, dodge and crit avoidance. **No damage scaling at all.**',
    'The **rate** is engine-side and is in no game record, so this document gives no number for it and §4\'s `+% damage` figures exclude it. ' +
      'Weigh it as a direction, not a quantity: against this character\'s ' +
      `${Math.round(a.cunning.total)} Cunning and ${Math.round(a.spirit.total)} Spirit, a swap moving either by a few tens of points is **not** a damage argument and must not be used to block a move. ` +
      'It becomes one only when the shift is large against the total, or when it crosses a requirement — and requirements are checked exactly, above.',
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
    ...(d.lifeLeechPercent ? [`sustain: ${d.lifeLeechPercent.toFixed(1)}% of attack damage converted to health`] : []),
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

  const under = RESIST_COLUMNS.filter((c) => (overcap[c.key] ?? 0) < 0);
  out.line();
  out.line(
    under.length
      ? `**Under cap** (each figure is that resistance, in points): ${under.map((c) => `${c.label} ${num(overcap[c.key] ?? 0)}`).join(' · ')}. Everything else is at or over cap; points spent past cap are wasted except as buffer against enemy resistance reduction.`
      : '**Every resistance is at or above its cap** at this difficulty. Further resistance is buffer against enemy resistance reduction only.',
  );

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

function buildProfile(out: Writer, ctx: RenderContext): void {
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
  }
  if (d.totalDamagePercent) out.line(`\`+${num(d.totalDamagePercent)}% Total Damage\` scales every type at once and so ranks none of them.`);

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
    out.line(`**Weapon attack composition:** ${shares}${d.weaponAttack.mainAttack ? ` — main attack is **${d.weaponAttack.mainAttack}**` : ''}. This is what every point of flat damage on gear feeds.`);
  }

  if (d.skillDamage.length) {
    out.line();
    out.line('**Per-skill damage typing** (a conversion here belongs to that skill only, never to the character):');
    out.bullets(
      d.skillDamage.map((s) => {
        const parts = [
          ...(s.weaponDamagePct ? [`${s.weaponDamagePct}% weapon damage`] : []),
          ...s.flat.map((f) => `${signed(f.amount)} ${f.label} Damage${f.overTime ? ' over time' : ''}`),
          ...s.conversions.map((c) => `converts ${num(c.percent)}% ${c.from} → ${c.to} *(this skill only)*`),
        ];
        return `**${s.skill}** rank ${s.rank}${s.isDefaultAttack ? ' *(default attack replacer)*' : ''}: ${parts.join(' · ') || 'no damage of its own'}`;
      }),
    );
  }

  if (d.resistReduction.length) {
    out.line();
    out.line('**Resistance reduction the build applies to enemies** (offence — it does not raise the character\'s own resistances):');
    out.bullets(d.resistReduction.map((rr) => `${rr.source}: ${rr.effect} ${num(rr.value)}`));
  }

  wieldingLines(out, ctx);

  if (d.weaponRestrictions.length) {
    out.line();
    out.line('**Weapon-restricted skills** — a weapon outside the list bricks the skill:');
    out.bullets(d.weaponRestrictions.map((r) => `${r.skill}: ${r.weapons.join(', ')}`));
  }

  const top = d.ranked.slice(0, 2).map((e) => e.label);
  out.line();
  out.line(`**Build focus: ${top.join(' + ') || 'undetermined'}** — this is the post-conversion path every candidate's damage stats are judged against.`);
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
  const statLines = (stats: Record<string, number | string> | undefined, read?: (v: StatValue) => number) =>
    stats ? formatStats(stats, { db, invested: ctx.invested, ...(read ? { read } : {}) }) : [];

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

function acceptsComponent(item: ResolvedItem): boolean {
  return COMPONENT_SLOTS.test(item.base?.slot ?? '');
}

function acceptsAugment(item: ResolvedItem): boolean {
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
  const shortfalls = new Set<ResistKey>(
    RESIST_COLUMNS.filter((c) => (r.effective[c.key] ?? 0) < (r.caps[c.key] ?? 0)).map((c) => c.key),
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

function candidatesSection(out: Writer, ctx: RenderContext, selection: CandidateSelection): void {
  out.h(2, '7. Candidates — everything not worn, by slot');
  out.line('Ranked by: covers a resistance shortfall > matches the build focus (post-conversion, counting the item\'s own conversion and armor piercing) > rarity > level proximity. A failing requirement is **not** a rejection — decide between an enabler combination, HOLD-until, and discard.');

  for (const group of EQUIP_GROUPS) {
    const list = selection.byGroup.get(group);
    if (!list?.length) continue;
    const dropped = selection.dropped.get(group) ?? 0;
    out.line();
    out.line(`### ${group}${dropped ? ` *(${dropped} lower-ranked candidate${dropped === 1 ? '' : 's'} not shown)*` : ''}`);
    for (const candidate of list) {
      out.line();
      candidateBlock(out, ctx, candidate);
    }
  }
  if (selection.outOfWindow) {
    out.line();
    out.line(`*(${selection.outOfWindow} further item(s) fell outside the level window of −25/+10 around level ${ctx.aggregate.level}, or were Common rarity covering nothing, and are not listed.)*`);
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

function census(out: Writer, ctx: RenderContext, selection: CandidateSelection, trim: Trim): void {
  const components = componentCensus(ctx, selection);

  const augments = new Map<string, CensusEntry>();
  for (const item of ctx.resolved.items) {
    if (item.base?.slot !== AUGMENT_CLASS) continue;
    const e = augments.get(item.base.record) ?? { item: item.base, loose: new Map<string, number>(), hosts: [] };
    e.loose.set(item.source, (e.loose.get(item.source) ?? 0) + Math.max(1, item.stackCount));
    augments.set(item.base.record, e);
  }

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
  if (plan.missing.length) return `blueprint learned but **not craftable**: needs ${reagents}, ${cost} — missing ${plan.missing.join(', ')}`;
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
function vendorStock(save: CharacterSave, db: GameDb, level: number): VendorStock[] {
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
  /** Learned blueprint record paths. */
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

  const known = new Set(resolved.recipes.map((r) => r.record));
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
    '`KEEP` — with the reason it beats the listed alternatives',
    '`EQUIP <item id>` — the candidate to wear instead',
    '`RE-AUGMENT <augment name>` — replace the augment (cheap: only the new augment costs anything)',
    '`ADD-COMPONENT <component name>` — fill an empty component socket (free)',
    '`SWAP-COMPONENT <component name>` — replace an installed component (destroys the old one, costs an iron fee, and removes the augment)',
    '`BUY-AUGMENT <augment name>` — from a faction in §9, within the iron on hand',
    '`CRAFT <blueprint>` — only when §10 marks it craftable now, or says exactly what is missing',
  ]);
  out.line();
  out.line('Then give:');
  out.bullets([
    'a **HOLD** list — items to keep for a level or attribute threshold, naming the threshold',
    'a **SELL/SALVAGE** list — only for items no plausible version of this build reaches',
    'the reasoning behind each non-obvious call, in one or two sentences',
  ]);
  out.line();
  out.line('Finally, a **projected "after" summary** — the same numbers §3, §4 and §5 report now, restated for the recommended loadout, so the cost of every gain is visible:');
  out.bullets([
    'the **resistance table**, in the same columns as §3, with over/under cap per resistance at this difficulty',
    'the **armour** figure for the weakest body part and the hit-weighted mean, since a swap moves one part at a time',
    '**health**, **Offensive Ability** and **Defensive Ability** deltas (as contributions — the engine base is not modelled)',
    '**Physique / Cunning / Spirit** totals, and a confirmation that every item in the projected loadout still meets its requirements *after* the outgoing items\' `+Attribute` and `-% Requirement` bonuses are gone',
    'the **damage profile**: the top two post-conversion types and roughly what happens to their `+%` totals and flat pools, plus any change to the weapon-attack composition',
    '**skill ranks that move** — a swap that changes `+N to <skill>` shifts every stat read at that rank, including resistances already counted above',
    '**attack, casting and movement speed** restated against their caps, using §3\'s figures and headroom — attack speed multiplies all damage throughput, so a swap that moves it has a damage consequence that the §4 profile does not show',
    'anything pushed **past a cap** — speed past the §3 ceilings, or a resistance past its cap (both are wasted stats, not gains)',
  ]);
  out.line();
  out.line('Give the projection as concrete numbers where §3–§5 gave numbers, and say plainly when a figure cannot be derived from this document instead of estimating it silently.');
  out.line();
  out.line('Then a **Next levels** section, ordered cheapest-first, using the thresholds §12 has already grouped and costed. One line per threshold: what to spend, what it unlocks, and whether it is worth committing to. Attribute points and farming targets are in scope; skill and devotion trees are not.');
  out.line();
  out.line('Hard constraints:');
  out.bullets([
    'never propose a socketable for a slot its use-on restriction rejects',
    'never propose a swap that leaves the character unable to meet an item\'s requirements once the outgoing item\'s bonuses and reductions are gone — re-check the whole post-swap loadout',
    'never remove the last dual-wield enabler while leaving two one-handed weapons equipped',
    'never propose moving or trading an item that is soulbound by an applied augment',
    'never count `+% speed` past the caps in §2, and never count a resistance past its cap as a gain',
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
      `An item with two gaps appears under both and says so — it unlocks only when **all** of them are met.`,
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
