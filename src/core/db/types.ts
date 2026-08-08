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

export interface DbRecipe {
  /** Blueprint record path (as stored in `formulas.gst`). */
  record: string;
  /** Localized blueprint name, e.g. "Blueprint: Bloodrager's Cowl". */
  name: string;
  /** Localized name of the item the blueprint crafts, when resolvable. */
  resultName?: string;
  /** Record path of the crafted item. */
  resultRecord?: string;
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
}
