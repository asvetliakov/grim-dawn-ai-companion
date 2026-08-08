/**
 * The `GameDb` seam.
 *
 * Everything downstream (resolver, context builder, UI) talks to this interface
 * and never to a backend. The only implementation reads the installed game — its
 * `.arz` record archives and its `Text_<LOCALE>.arc` text archives — so a
 * different backend (a mod's database, a future dump format) can drop in behind
 * this interface without a ripple.
 */

/**
 * Faction *market* tiers, in ascending order. These are the four thresholds a
 * vendor's stock is gated on — "Trusted" is a reputation level in game but never
 * a market tier, which is why it is absent.
 */
export type RepTier = 'Friendly' | 'Respected' | 'Honored' | 'Revered';

export const REP_TIERS: readonly RepTier[] = ['Friendly', 'Respected', 'Honored', 'Revered'];

export interface VendorSource {
  factionId: string;
  /** Lowest market tier at which this faction stocks the item. */
  repTier: RepTier;
}

/**
 * A stat value as the game data spells it. Numbers and strings are per-item
 * constants; an array is a **per-rank table** — skills index it by learned rank,
 * set bonuses by equipped-piece count. Arrays are the whole reason skills need
 * their own extractor: the item extractor drops them.
 */
export type StatValue = number | string | number[];

/**
 * Attribute requirements in save-file naming: physique = the data's `strength`,
 * cunning = `dexterity`, spirit = `intelligence`. An absent key means the item
 * demands nothing of that attribute.
 */
export interface AttrRequirements {
  physique?: number;
  cunning?: number;
  spirit?: number;
}

export interface DbItem {
  /** DBR record path — the key items are stored under in saves. */
  record: string;
  /** Localized display name, or a best-effort fallback when no tag resolves. */
  name: string;
  levelReq: number;
  /** `itemClassification`: Common, Magical, Rare, Epic, Legendary, Quest. */
  rarity: string;
  /** Template class, e.g. `ArmorProtective_Head`, `ItemEnchantment`. */
  slot: string;
  /** In-archive `.tex` path; Stage 4's icon service turns this into a PNG. */
  iconPath: string;
  /** Raw DBR stat keys (`defensiveLightning`, `characterOffensiveAbility`, …). */
  stats: Record<string, number | string>;
  /** Localized set name, when the item belongs to one. */
  setName?: string;
  /** The set's record path — the key into `getSet`. */
  setRecord?: string;
  /**
   * The skill this item grants outright (`itemSkillName`): relics, runes and a
   * few components. Name only — aggregating a granted skill's stats is backlog.
   */
  grantedSkill?: { record: string; name: string };
  /** Which archive supplied the record: `base`, `gdx1`, `gdx2`, `gdx3`. */
  expansion?: string;
  /**
   * Faction vendors that stock this item, with the tier each unlocks it at.
   * Plural because several factions sell the same consumables and component
   * blueprints — collapsing that to one source would quietly lose the cheaper
   * one for a given character.
   */
  vendors?: VendorSource[];
  /** Localized flavour/description text, when the record carries one. */
  description?: string;
  /**
   * Attribute requirements, evaluated at build time from the item's
   * `itemCostName` cost equations (or the record's explicit override — one
   * quest item in the whole game). Requirements are *not* stored on item
   * records; they are a function of `itemLevel` and the item's slot class.
   * Absent = the item genuinely has none (medals, gear without a cost record).
   */
  attrReq?: AttrRequirements;
  /**
   * Rings and amulets only: the extra requirement per populated stat entry
   * beyond the first on the *rolled* item — their equations carry a
   * `totalAttCount` term the other slots' don't. `attrReq` is the baseline at
   * one stat; the resolver adds `attrReqPerStat × (statCount − 1)`.
   */
  attrReqPerStat?: AttrRequirements;
}

/**
 * A skill record — mastery skills, devotion nodes, and the buff records they
 * hop to.
 *
 * `stats` keeps the raw DBR keys exactly as the item tables do, except that
 * per-rank arrays survive: `characterOffensiveAbility = [10,20,29,…]` is the
 * value at ranks 1,2,3… Read it at the *effective* rank (invested points plus
 * every equipped `+N to <skill>`), clamped to the array's length.
 */
export interface DbSkill {
  record: string;
  /** Localized name. Absent on the plumbing records that carry no display tag. */
  name?: string;
  /** Template class: `Skill_Passive`, `Skill_BuffSelfDuration`, `SkillBuff_Debuf`, … */
  class: string;
  /** Position in the mastery tree; the tier gate, not a rank. */
  tier?: number;
  /** Highest rank reachable with plain skill points. */
  maxLevel?: number;
  /** Highest rank reachable at all — where `+N to <skill>` bonuses stop counting. */
  ultimateLevel?: number;
  /** Seconds. Together with `duration` this is what makes a buff maintainable. */
  cooldown?: number;
  duration?: number;
  /**
   * `buffSkillName`: toggled auras and shouts are two records — a thin activator
   * and the buff that holds every number. Follow this before reading `stats`.
   */
  buffRecord?: string;
  /** `_classtraining_classNN.dbr` — the target of a `+N to all <mastery> skills`. */
  mastery?: string;
  /**
   * Weapons the skill will fire with, as DBR field names (`Sword2h`, `Ranged1h`).
   * Empty means unrestricted; a non-empty list is a whitelist, and recommending
   * a weapon outside it bricks the skill.
   */
  weapons?: string[];
  stats: Record<string, StatValue>;
  description?: string;
}

/**
 * An item set. Every numeric bonus is an array indexed by *equipped piece count
 * minus one* — `characterLifeModifier = [0,8,8]` is nothing for one piece and
 * +8% from two onward. Record-path fields (`augmentSkillName1`) stay scalar and
 * name the target of the indexed level array beside them.
 */
export interface DbSet {
  record: string;
  name: string;
  members: string[];
  bonuses: Record<string, StatValue>;
}

/**
 * A prefix, suffix, rare-monster modifier, crafting bonus or relic completion
 * bonus — the game models all of them as one `LootRandomizer` class.
 *
 * The stats are the record's base values; the engine rolls each one within
 * ±`jitter` percent, so they are an anchor rather than the exact numbers on any
 * one item. On magical and rare gear the affixes often *are* the resistances,
 * which is why an item-only sum reads far too low.
 */
export interface DbAffix {
  record: string;
  /** Absent for the crafting bonuses the game deliberately leaves unnamed. */
  name?: string;
  stats: Record<string, number | string>;
  /** `lootRandomizerJitter` — the ± percentage the roll varies by. */
  jitter?: number;
  /**
   * Affixes gate the rolled item's level: its effective requirement is
   * `max(base, prefix, suffix)`, not the base item's field alone.
   */
  levelReq?: number;
}

export interface DbFaction {
  /** Stable id: `f<n>` for the game's numbered user factions, else a slug. */
  id: string;
  /** Localized name, e.g. "Kymon's Chosen". */
  name: string;
  /** The faction's DBR record path. */
  record: string;
  /** True when the faction runs a reputation-gated vendor. */
  hasVendor: boolean;
}

export interface DbReagent {
  record: string;
  /** Localized name, when the reagent resolves to a known item. */
  name?: string;
  quantity: number;
}

export interface DbRecipe {
  /** Blueprint record path (as stored in `formulas.gst`). */
  record: string;
  /** Localized blueprint name, e.g. "Blueprint: Bloodrager's Cowl". */
  name: string;
  /** Localized name of the item the blueprint crafts, when resolvable. */
  resultName?: string;
  /** Record path of the crafted item. */
  resultRecord?: string;
  /** Materials consumed besides `baseReagent` — what makes CRAFT advice checkable. */
  reagents: DbReagent[];
  /**
   * The item consumed and upgraded. Present on upgrade recipes — an awakened
   * blueprint takes the ordinary item as its base — and it is what makes "an
   * awakened version of this exists" derivable, which is a HOLD signal.
   */
  baseReagent?: DbReagent;
  /** Iron cost of one craft (`artifactCreationCost`, which the DBR stores as text). */
  ironCost?: number;
}

export interface GameDb {
  /** e.g. "Version 1.3.0.0". */
  gameVersion: string;
  getItem(record: string): DbItem | undefined;
  /** Localized prefix/suffix name, e.g. "Shrewd". Undefined for unnamed affixes. */
  getAffixName(record: string): string | undefined;
  /**
   * Whether the affix record exists at all. Distinct from `getAffixName`
   * returning a value: the crafting-bonus affixes a blacksmith rolls onto a
   * crafted item (`records/items/lootaffixes/crafting/…`) carry no name in the
   * game data, so "known but nameless" is a correct answer, not a lookup failure.
   */
  knowsAffix(record: string): boolean;
  /** The affix record with its stats, for summing an item's real contribution. */
  getAffix(record: string): DbAffix | undefined;
  /**
   * A fully indexed skill. Only mastery skills, devotion nodes, the buff records
   * they hop to, and the skill-modifier records items reference get one — every
   * other `records/skills/` path is name-only, via `skillName`.
   */
  getSkill(record: string): DbSkill | undefined;
  getSet(record: string): DbSet | undefined;
  /**
   * Localized name for *any* skill record, so a `+N to <skill>` line never has to
   * render a raw DBR path. Undefined when the record carries no display tag.
   */
  skillName(record: string): string | undefined;
  /**
   * The resistance penalty a difficulty applies, as raw `defensive*` field →
   * negative amount. Read from the game's balancing record rather than assumed:
   * the penalty differs per resistance and Physical takes none.
   */
  difficultyPenalty(difficulty: string): Record<string, number>;
  /**
   * Base armour absorption as a percentage (70). `+% Armor Absorption`
   * multiplies it — 70 × 1.2 = 84 — so reporting a resulting figure needs it.
   */
  armorAbsorptionBase(): number;
  factions(): DbFaction[];
  /** Everything a faction vendor stocks up to and including `maxTier`. */
  vendorItems(factionId: string, maxTier: RepTier): DbItem[];
  recipes(): DbRecipe[];
  localize(tag: string): string;
  /** Coverage/consistency numbers for `cli db --stats`. */
  stats(): DbStats;
}

export interface DbStats {
  gameVersion: string;
  /** The language these names are in. */
  locale: string;
  /** Every language the install could be rebuilt in — settings' `locale` field. */
  locales: string[];
  /** Cache key for this game build. */
  fingerprint: string;
  builtAt: string;
  archives: string[];
  items: number;
  affixes: number;
  /** Affixes with a display name; the rest are the game's nameless crafting bonuses. */
  namedAffixes: number;
  localizedNames: number;
  l10nTags: number;
  factions: number;
  vendorFactions: number;
  vendorItems: number;
  recipes: number;
  /** Skill records indexed with full per-rank stats. */
  skills: number;
  /** Every `records/skills/` path, name-only — what `skillName` can answer for. */
  skillNames: number;
  sets: number;
  /** Items whose cost equations produced an attribute requirement. */
  itemsWithAttrReq: number;
}
