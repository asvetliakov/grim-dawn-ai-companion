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
import type { CharacterAggregate, MatrixRow } from '../mechanics/aggregate.js';
import type { CharacterStanding, RequirementCheck } from '../mechanics/requirements.js';
import { atRank, modifierParent, skillLabel, statRecord } from '../mechanics/skills.js';
import {
  ATTR_KEYS,
  RESIST_COLUMNS,
  type DamageKey,
  type ResistKey,
  type ResistVector,
} from '../mechanics/stats.js';
import type { ResolvedCharacter, ResolvedItem } from '../resolve.js';
import { factionSlot, factionTier } from '../save/factions.js';
import { EQUIP_SLOT_NAMES, type CharacterSave } from '../save/types.js';
import {
  estimateTokens,
  EQUIP_GROUPS,
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

  return {
    markdown: doc,
    tokenEstimate: estimateTokens(doc),
    trimmed,
    itemIds: idIndex(input.resolved.items),
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

function idIndex(items: readonly ResolvedItem[]): Map<string, string> {
  const ids = assignIds(items);
  return new Map([...ids].map(([item, id]) => [id, item.display]));
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
  const ctx: RenderContext = { ...input, ids, equipped, invested };

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

  return out.toString();
}

interface RenderContext extends ContextInput {
  ids: Map<ResolvedItem, string>;
  equipped: ResolvedItem[];
  /** Skill records with at least one invested point. */
  invested: Set<string>;
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

function gameRules(out: Writer, ctx: RenderContext): void {
  const { aggregate, db } = ctx;
  const caps = db.speedCaps();
  const penalty = RESIST_COLUMNS.map((c) => `${c.label} ${num(aggregate.resistances.penalty[c.key] ?? 0)}`).join(', ');

  out.h(2, '2. Game rules (v1.3, Fangs of Asterkarn — do not substitute older knowledge)');

  out.line('**Resistances.** Each of the ten damage resistances caps at 80%. `+% Maximum X Resistance` raises that cap, to a hard ceiling of 95%. The difficulty penalty is subtracted from the total *before* the cap, and it is **not uniform** — the in-game "−25%/−50% to all resistances" blurb is a simplification. On this character\'s difficulty the penalty is:');
  out.line();
  out.line(`> ${aggregate.difficulty}: ${penalty}`);
  out.line();
  out.line('Enemies in the late game carry resistance reduction of their own, so the community target is **+20 to +30 overcap** on the resistances a build actually faces, not exactly 80. Being under cap on a resistance the character meets constantly is the single most common cause of death.');

  out.line();
  out.line('**Armour is localized, not pooled.** Every physical hit rolls one body part — Head 12%, Shoulders 12%, Chest 24%, Hands 16%, Legs 20%, Feet 16% — and is met by *that piece alone*. Summing six ratings describes a character who does not exist. Flat `+Armor` from rings, components and skills is added to **every** part. Absorption is multiplicative on a 70% base: `+20% Armor Absorption` gives 84%, not 90%, and it caps at 100%.');

  out.line();
  out.line(`**Speed caps** (engine values): attack ${caps.attack}%, cast ${caps.cast}%, movement ${caps.run}%. \`+% speed\` past a cap is worth nothing — never trade a real stat for it on a build already at cap.`);

  out.line();
  out.line('**Sockets.** An item holds up to **one component** and **one augment**, in independent sockets.');
  out.bullets([
    'Every component and augment carries a use-on restriction (listed with it below). It may only be proposed for gear that restriction accepts.',
    'Applying a loose socketable to an **empty** socket is free and instant.',
    'Augments are consumables bought from faction vendors with iron. Removing one **destroys** it — it is never recovered — so replacing an augment costs only the price of the new one. Treat every augment slot as a free variable.',
    'Applying an augment **soulbinds** the item: it cannot be traded or placed in the transfer stash until the augment is removed (which destroys the augment).',
    "An occupied **component** socket goes through the Inventor's salvage, which is either/or with an iron fee: **keep the item → the installed component is destroyed** (and any augment with it), or **keep the component → the host item is destroyed** (and its augment). So upgrading a kept item's component costs the old component + fee + a fresh augment, and moving a single-instance component to new gear costs the old item.",
    'Partial components no longer exist in the game — a component is always whole.',
  ]);

  out.line();
  out.line('**Requirements.** Items demand a character level and Physique/Cunning/Spirit.');
  out.bullets([
    '`-% Requirement` reductions stack additively and are scoped by gear family (Armor, Jewelry, Shield, Weapon, Melee, Hunting), with Global stacking on top of the scope.',
    'A reduction or a `+Attribute` granted by an item **vanishes when that item is swapped out**, so any joint move has to be re-checked against the post-swap loadout.',
    'One unspent attribute point = 8 points of any one attribute.',
    'A deficit that levelling or unspent points will close is a **HOLD-until**, never a reject.',
  ]);

  out.line();
  out.line('**Dual wielding requires an enabler**: a mastery passive (Dual Blades, Implements of War) or an item-granted skill (Direwolf Claw, Mutilate, Bloodbath, Gunslinger\'s Talent). A swap that removes the *last* enabler while leaving two one-handers is illegal, not merely weak.');

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
  out.line(`**Faction vendors.** Market tiers unlock at Friendly ≥1,501, Respected ≥5,001, Honored ≥10,001, Revered ≥25,000 reputation. ("Trusted" is a reputation level in game but *not* a market tier.) Only the tiers this character has actually reached are listed in §9, and each augment's iron price is quoted against the iron on hand in §1.`);
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
    `unspent: ${a.unspentPoints} attribute point(s) (8 attribute each), ${save.attributes.skillPoints} skill point(s), ${save.attributes.devotionPoints} devotion point(s)`,
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

  defenseBlock(out, ctx);
  resistanceMatrix(out, ctx);
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
      ? `**Under cap:** ${under.map((c) => `${c.label} ${num(overcap[c.key] ?? 0)}`).join(', ')}. Everything else is at or over cap; points spent past cap are wasted except as buffer against enemy resistance reduction.`
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
      .map((s) => `${s.share}% ${s.label.toLowerCase()}${s.overTime ? ' (over time)' : ''}`)
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
          ...s.flat.map((f) => `${signed(f.amount)} ${f.label.toLowerCase()}${f.overTime ? ' over time' : ''}`),
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

  const w = ctx.aggregate.wielding;
  out.line();
  const enablers = w.enablers.length
    ? w.enablers.map((e) => (e.source === 'skill' ? `${e.name} (mastery passive)` : `${e.name}, ${e.source}`)).join('; ')
    : undefined;
  out.line(
    `**Wielding:** ${w.mode}${w.mainHand ? ` — ${w.mainHand}${w.offHand ? ` + ${w.offHand}` : ''}` : ''}.` +
      (w.mode.startsWith('dual-wield')
        ? enablers
          ? ` Dual wield is enabled by: ${enablers}. Any swap must keep at least one of these.`
          : ' **No dual-wield enabler was found — treat this as a gap in the model, not permission to drop one.**'
        : ''),
  );

  if (d.weaponRestrictions.length) {
    out.line();
    out.line('**Weapon-restricted skills** — a weapon outside the list bricks the skill:');
    out.bullets(d.weaponRestrictions.map((r) => `${r.skill}: ${r.weapons.join(', ')}`));
  }

  const top = d.ranked.slice(0, 2).map((e) => e.label);
  out.line();
  out.line(`**Build focus: ${top.join(' + ') || 'undetermined'}** — this is the post-conversion path every candidate's damage stats are judged against.`);
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
    emit(out, `component: **${item.component.name}** (use-on: ${describeSlots(item.component.allowedSlots)})`, statLines(item.component.stats));
  } else if (acceptsComponent(item)) {
    out.line('- **component socket: EMPTY** — a free upgrade, no salvage needed');
  }
  if (item.augment) {
    emit(out, `augment: **${item.augment.name}**${augmentSource(item.augment, db)}`, statLines(item.augment.stats));
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

function candidateBlock(out: Writer, ctx: RenderContext, candidate: Candidate): void {
  const { item } = candidate;
  const tag = SOURCE_TAG[item.source] ?? `[${item.source}]`;
  itemBlock(out, ctx, item, `${tag} ${item.location}`, candidate.check, 4);

  const notes: string[] = [];
  if (candidate.covers.length) notes.push(`covers a current shortfall in ${candidate.covers.join(', ')}`);
  if (candidate.identity) {
    const id = candidate.identity;
    const damage = id.types.map((t) => `${t.min}–${t.max} ${t.label.toLowerCase()}`).join(', ');
    if (damage) {
      notes.push(`deals ${damage}${id.pierceRatio ? ` (${num(id.pierceRatio)}% armor piercing already applied)` : ''}`);
    }
    for (const conversion of id.conversions) {
      notes.push(`grants ${num(conversion.percent)}% ${conversion.from} → ${conversion.to} conversion (global once worn)`);
    }
  }
  notes.push(candidate.onType ? 'matches the build focus' : '**off-type** for the current build focus');
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
}

function census(out: Writer, ctx: RenderContext, selection: CandidateSelection, trim: Trim): void {
  const shown = new Map<ResolvedItem, string>();
  for (const item of ctx.equipped) shown.set(item, ctx.ids.get(item) ?? item.id);
  for (const candidate of [...selection.byGroup.values()].flat()) {
    shown.set(candidate.item, ctx.ids.get(candidate.item) ?? candidate.item.id);
  }

  const components = new Map<string, CensusEntry>();
  const augments = new Map<string, CensusEntry>();
  const entry = (map: Map<string, CensusEntry>, item: DbItem): CensusEntry => {
    const existing = map.get(item.record) ?? { item, loose: new Map<string, number>(), hosts: [] };
    map.set(item.record, existing);
    return existing;
  };

  for (const item of ctx.resolved.items) {
    if (item.base?.slot === COMPONENT_CLASS) {
      const e = entry(components, item.base);
      e.loose.set(item.source, (e.loose.get(item.source) ?? 0) + Math.max(1, item.stackCount));
    }
    if (item.base?.slot === AUGMENT_CLASS) {
      const e = entry(augments, item.base);
      e.loose.set(item.source, (e.loose.get(item.source) ?? 0) + Math.max(1, item.stackCount));
    }
    // Installed copies. Anything not printed elsewhere is still named by its
    // host's location, so "the only copy is inside this item" stays visible.
    if (item.component) {
      const id = shown.get(item) ?? ctx.ids.get(item) ?? item.id;
      entry(components, item.component).hosts.push({ id, where: `${item.display} (${item.location})` });
    }
  }

  const materials = new Map<string, { name: string; count: number }>();
  for (const item of ctx.resolved.items) {
    if (!item.record.startsWith(MATERIAL_PREFIX)) continue;
    const existing = materials.get(item.record) ?? { name: item.base?.name ?? item.record, count: 0 };
    existing.count += Math.max(1, item.stackCount);
    materials.set(item.record, existing);
  }

  out.h(2, '8. Component and augment census (every container)');
  out.line('Scarcity is the point of this section: a component whose only copy is installed can still be moved, but only by destroying its host.');

  if (trim.compressCensus) {
    out.line();
    out.line(`- ${components.size} distinct component(s) owned, ${[...components.values()].filter(onlyInstalled).length} of them only as an installed copy`);
    out.line(`- ${augments.size} distinct loose augment(s) on hand`);
  } else {
    out.line();
    out.line('**Components:**');
    for (const e of [...components.values()].sort((a, b) => a.item.name.localeCompare(b.item.name))) {
      const loose = [...e.loose].map(([source, n]) => `${n}× ${SOURCE_TAG[source] ?? source}`).join(', ');
      const parts = [
        loose ? `loose: ${loose}` : 'none loose',
        e.hosts.length ? `installed in ${e.hosts.map((h) => `\`#${h.id}\` ${h.where}`).join(', ')}` : '',
        `use-on: ${describeSlots(e.item.allowedSlots)}`,
      ].filter(Boolean);
      const scarce = onlyInstalled(e)
        ? ` — **single instance — extraction destroys ${e.hosts.map((h) => `\`#${h.id}\``).join(' / ')}**`
        : '';
      out.line(`- **${e.item.name}** — ${parts.join('; ')}${scarce}`);
    }

    if (augments.size) {
      out.line();
      out.line('**Loose augments on hand** (installed ones are shown with their item in §5/§7 and can never be recovered):');
      for (const e of [...augments.values()].sort((a, b) => a.item.name.localeCompare(b.item.name))) {
        const loose = [...e.loose].map(([source, n]) => `${n}× ${SOURCE_TAG[source] ?? source}`).join(', ');
        out.line(`- **${e.item.name}** — ${loose}; use-on: ${describeSlots(e.item.allowedSlots)}`);
      }
    }
  }

  out.line();
  out.line(
    materials.size
      ? `**Crafting materials on hand:** ${[...materials.values()].sort((a, b) => b.count - a.count).map((m) => `${m.name} ×${m.count}`).join(', ')}`
      : '**Crafting materials on hand:** none.',
  );
}

function onlyInstalled(entry: CensusEntry): boolean {
  return entry.hosts.length === 1 && entry.loose.size === 0;
}

// ---------------------------------------------------------------------------
// 9 — faction augments
// ---------------------------------------------------------------------------

/** Tiers up to and including the one reached, ascending. */
function tiersUpTo(tier: string): RepTier[] {
  const index = REP_TIERS.indexOf(tier as RepTier);
  return index < 0 ? [] : REP_TIERS.slice(0, index + 1);
}

function factionAugments(out: Writer, ctx: RenderContext): void {
  const { save, db, aggregate } = ctx;
  out.h(2, '9. Faction augments available now');
  out.line('Only factions this character has unlocked, only tiers actually reached, only augments at or below the character\'s level. Prices are per augment; iron on hand is in §1.');

  let any = false;
  for (const rep of save.factions) {
    if (!rep.unlocked) continue;
    const slot = factionSlot(rep.id);
    if (!slot) continue;
    const tier = factionTier(rep.value);
    const reached = tiersUpTo(tier);
    if (reached.length === 0) continue;
    const faction = db.factions().find((f) => f.id === slot.id);
    if (!faction?.hasVendor) continue;

    const stock = db
      .vendorItems(slot.id, reached.at(-1)!)
      .filter((item) => item.slot === AUGMENT_CLASS && item.levelReq <= aggregate.level);
    if (stock.length === 0) continue;

    any = true;
    out.line();
    out.line(`### ${faction.name} — ${tier} (${Math.round(rep.value).toLocaleString('en-US')} reputation)`);
    for (const augment of stock.sort((a, b) => b.levelReq - a.levelReq || a.name.localeCompare(b.name))) {
      const at = augment.vendors?.find((v) => v.factionId === slot.id)?.repTier ?? tier;
      const cost = augment.stats['itemCost'];
      const lines = formatStats(augment.stats, { db, invested: ctx.invested });
      out.line(
        `- **${augment.name}** (lvl ${augment.levelReq}, ${at}, ${typeof cost === 'number' ? cost.toLocaleString('en-US') : '?'} iron) — use-on: ${describeSlots(augment.allowedSlots)} — ${lines.join('; ')}`,
      );
    }
  }
  if (!any) out.line('\nNo faction vendor this character has unlocked stocks a level-appropriate augment.');
}

// ---------------------------------------------------------------------------
// 10 — blueprints and upgrade paths
// ---------------------------------------------------------------------------

function blueprints(out: Writer, ctx: RenderContext, selection: CandidateSelection, trim: Trim): void {
  const { db, save, resolved, aggregate } = ctx;
  out.h(2, '10. Blueprints and upgrade paths');

  // What the account can actually consume, pooled across every container.
  const onHand = new Map<string, number>();
  for (const item of resolved.items) {
    onHand.set(item.record, (onHand.get(item.record) ?? 0) + Math.max(1, item.stackCount));
  }

  const known = new Set(resolved.recipes.map((r) => r.record));
  const byRecord = new Map(db.recipes().map((r) => [r.record, r]));

  const missingFor = (recipe: DbRecipe): string[] => {
    const gaps: string[] = [];
    for (const reagent of [...(recipe.baseReagent ? [recipe.baseReagent] : []), ...recipe.reagents]) {
      const have = onHand.get(reagent.record) ?? 0;
      if (have < reagent.quantity) gaps.push(`${reagent.name ?? reagent.record} ${have}/${reagent.quantity}`);
    }
    if ((recipe.ironCost ?? 0) > save.iron) gaps.push(`iron ${save.iron.toLocaleString('en-US')}/${(recipe.ironCost ?? 0).toLocaleString('en-US')}`);
    return gaps;
  };

  const relevant = [...known]
    .map((record) => byRecord.get(record))
    .filter((recipe): recipe is DbRecipe => Boolean(recipe))
    .filter((recipe) => {
      const result = recipe.resultRecord ? db.getItem(recipe.resultRecord) : undefined;
      if (!result) return false;
      // Materials and consumables are means, not ends; gear and relics are ends.
      if (result.record.startsWith(MATERIAL_PREFIX)) return false;
      return result.levelReq <= aggregate.level + 10 && result.levelReq >= aggregate.level - 25;
    })
    .sort((a, b) => (db.getItem(b.resultRecord ?? '')?.levelReq ?? 0) - (db.getItem(a.resultRecord ?? '')?.levelReq ?? 0));

  const craftable = relevant.filter((r) => missingFor(r).length === 0);

  out.line(`Learned blueprints: ${resolved.recipes.length}. Within the level window and not a raw material: ${relevant.length}, of which **${craftable.length} are craftable right now**.`);

  if (trim.compressRecipes) {
    out.line();
    out.bullets(craftable.slice(0, 15).map((r) => `**${r.resultName ?? r.name}** — craftable now (${(r.ironCost ?? 0).toLocaleString('en-US')} iron)`));
    if (craftable.length > 15) out.line(`- … and ${craftable.length - 15} more craftable now`);
  } else {
    out.line();
    for (const recipe of relevant) {
      const gaps = missingFor(recipe);
      const reagents = [...(recipe.baseReagent ? [recipe.baseReagent] : []), ...recipe.reagents]
        .map((r) => `${r.quantity}× ${r.name ?? r.record}`)
        .join(', ');
      const result = recipe.resultRecord ? db.getItem(recipe.resultRecord) : undefined;
      out.line(
        `- **${recipe.resultName ?? recipe.name}** (lvl ${result?.levelReq ?? '?'}) — ${reagents || 'no reagents'}, ${(recipe.ironCost ?? 0).toLocaleString('en-US')} iron — ` +
          (gaps.length ? `missing ${gaps.join(', ')}` : '**craftable now**'),
      );
    }
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
      const gaps = missingFor(recipe);
      notes.add(
        `**${item.display}** upgrades to **${recipe.resultName ?? recipe.name}** — ${reagents}, ${(recipe.ironCost ?? 0).toLocaleString('en-US')} iron` +
          (known.has(recipe.record) ? '' : ' *(blueprint not learned)*') +
          (gaps.length ? ` — missing ${gaps.join(', ')}` : ' — **all reagents on hand**'),
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
    'anything that crosses a **speed cap** from §2, and any resistance pushed past its cap (both are wasted stats, not gains)',
  ]);
  out.line();
  out.line('Give the projection as concrete numbers where §3–§5 gave numbers, and say plainly when a figure cannot be derived from this document instead of estimating it silently.');
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
