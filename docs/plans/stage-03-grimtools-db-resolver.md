# Stage 3 — GrimTools DB provider + resolver + settings

## Goal

Give the tool a game item database: download and cache the GrimTools item DB dump, normalize it behind a `GameDb` interface, and resolve every item from the saves (record paths from Stages 1–2) into localized names/stats. Plus settings with save-dir auto-detection. CLI: `db`, `resolve`.

## Context

Save items are DBR record paths + a seed; everything human-readable comes from the game DB. GrimTools (by Dammitt) publishes its full database as fetchable JS — current for game 1.3 incl. Fangs of Asterkarn. We use it as the day-one backend; a self-parsed `.arz` backend may replace it post-v1 behind the same interface (see appendix).

**Etiquette (hard rules)**: fetch at most once per game version; keep the raw download in the local cache; never commit any of it (`.gitignore` already covers `cache/`, `itemdb.js`, `db.json`); credit GrimTools in README/UI.

## Data source facts (verified 2026-08)

- `https://www.grimtools.com/db/itemdb/itemdb.js` — ~8.7 MB plain JS assigning `window.*` globals. No auth.
- Evaluate with `vm.runInNewContext(src, sandbox)` where `sandbox = { window: {} }` (data is plain assignments; also expose the sandbox as `globalThis`-ish if the script writes bare globals). **Never `eval` in the main realm.**
- Globals of interest:
  - `window.gameVersion` — e.g. `"Version 1.3.0.0"` → cache key.
  - `window.allItems` — map itemId (`it123`) → item object. Short keys: `d`=name tag, `b`=description tag, `k`=level requirement, `n`=icon path (e.g. `items/enchants/enchantm_black.png`), `f`=rarity, `l`=item class/slot, `mods`=expansion (`["gdx2"]`), plus **raw DBR stat keys** (`defensiveLightning`, `characterOffensiveAbility`, `offensiveChaosModifier`, `augmentSkillName1`, …). Faction items carry `factions:["f13"]` and `repTier:"tagFactionStateFriend2"`.
  - `repTier` mapping: `tagFactionStateFriend1`=Friendly, `Friend2`=Respected, `Friend4`=Honored, `Friend5`=Revered (`Friend3`=Trusted is a rep level but never a market tier).
  - `window.factions` — 15 entries `{f5: {tag, icon, items: "it725 it389 ...".split-able}}`.
  - `window.merchants` + `window.merchantItems` (item → NPC ids), `window.crafters` + `window.crafterRecipes` (blueprint → crafters), `window.itemSets`.
  - The **record path ↔ itemId** mapping: inspect the dump — items carry their DBR record path (look for a key holding `records/...`; if absent, check `window.shortNameMapping`/related globals). Establishing this join is the first implementation task; the resolve-coverage gate below proves it.
- Localization: `https://www.grimtools.com/db/itemdb/l10n/en.js` → `db_l10n_texts['en'] = {tag: "text", ...}` (~17,700 tags). Resolves `d`/`b` tags and `tagFactionStateFriend*`.
- Unknown: whether the dump includes **prefix/suffix (affix) records**. The coverage report (below) answers this. Fallback if absent: display base name + a suffix derived from the affix record filename (e.g. `.../b_oa02_g.dbr` → show raw tail; `of Alacrity`-style names are often derivable). Record the finding in this file's Outcome section — it decides whether the post-v1 arz backend is needed for affix display or only for offline mode.

## Deliverables

```
src/core/db/types.ts      # GameDb + DbItem (the grimtools↔arz swap seam — keep backend-agnostic)
src/core/db/grimtools.ts  # download, vm-parse, zod-validate, normalize → GameDb
src/core/db/cache.ts      # ~/Library/Application Support/gd-companion/cache/<gameVersion>/
                          #   raw: itemdb.js, en.js; normalized: db.json (fast startup path)
src/core/resolve.ts       # resolveItem(inst, db): ResolvedItem; resolveCharacter(save, stash, formulas, db)
src/core/settings.ts      # ~/Library/Application Support/gd-companion/settings.json
src/cli/index.ts          # add `db [--refresh] [--stats]`, `resolve --char <name>`
test/db.test.ts, test/resolve.test.ts
```

Key interfaces:

```ts
type RepTier = 'Friendly' | 'Respected' | 'Honored' | 'Revered';
interface DbItem {
  record: string; name: string;            // localized
  levelReq: number; rarity: string; slot: string;
  iconPath: string;                        // feeds Stage 4
  stats: Record<string, number | string>;  // raw DBR keys
  setName?: string; expansion?: string;
  factionId?: string; repTier?: RepTier;
}
interface GameDb {
  gameVersion: string;
  getItem(record: string): DbItem | undefined;
  getAffixName(record: string): string | undefined;   // may return undefined — see coverage question
  factions(): { id: string; name: string }[];
  vendorItems(factionId: string, maxTier: RepTier): DbItem[];
  recipes(): { record: string; resultName?: string }[];
  localize(tag: string): string;
}
interface ResolvedItem {
  display: string;        // "Thunderstruck Legion Warhammer of Alacrity"
  base: DbItem; prefixName?: string; suffixName?: string;
  component?: DbItem; augment?: DbItem;
  source: 'equipped' | 'inventory' | 'stash' | 'transfer';
  unresolved: string[];   // record paths that failed to resolve (for the coverage report)
}
```

Settings (`zod`-validated): `saveDir` (auto-detect: glob `~/Library/Application Support/CrossOver/Bottles/*/drive_c/Program Files (x86)/Steam/userdata/*/219990/remote/save`, else the bottle's `drive_c/users/*/Documents/My Games/Grim Dawn/save`), `activeCharacter`, `locale` (default `en`), `provider`, `model`, `difficultyOverride?`.

Download with plain `fetch` (Node 24), honor cache: skip network entirely if `db.json` exists for the current cached gameVersion; `--refresh` forces re-fetch.

## Acceptance criteria

1. `npm run cli -- db` first run: downloads itemdb.js + en.js, prints gameVersion, item/faction/merchant counts; second run: loads from `db.json` **with zero network calls** (assert via a test with fetch mocked to throw).
2. `npm run cli -- resolve --char _Suchka`: every equipped/inventory/stash/transfer item prints with localized display name, rarity, level req. Final line: coverage summary, e.g. `resolved 214/220 base records (97.3%)`, with each miss listed.
3. **Gate: ≥95% of item *base* records across both characters + transfer stash resolve.** Report affix-name coverage separately (informational — answers the open question; add the answer to Outcome below).
4. `vendorItems('f<kymon-or-similar>', 'Respected')` returns a non-empty augment list in a unit test against the cached dump.
5. zod validation fails loudly (clear message naming the missing global/key) when fed a truncated/altered dump (unit test).
6. `npm test` + `npm run typecheck` green. Nothing game-derived under git (`git status` clean of cache files).

## Verification

```bash
npm test && npm run typecheck
npm run cli -- db --stats
npm run cli -- resolve --char _Suchka
npm run cli -- resolve --char _abcdef
git status --short   # no cache/fixture files
```

## Outcome

**Built and verified 2026-08-08. The gate passes at 100% (366/366 base records for `_Suchka`, 299/299 for `_abcdef`), not the 95% floor — but the backend is not the one this plan specified.**

### The plan's central premise was wrong

> "The record path ↔ itemId mapping: inspect the dump — items carry their DBR record path."

They do not. `itemdb.js` contains **zero** occurrences of `records/` (`grep -c "records/" itemdb.js` → 0), and `window.shortNameMapping` is only the short-key legend (`a`=itemNameTag, `n`=bitmap, `k`=levelRequirement, …). The one plausible join key, the `bitmap` filename, is **many-to-one**: `records/items/gearlegs/c109_legs.dbr` declares `bitmap: items/gearlegs/bitmaps/c103_legs.tex`, because records reuse art. Measured coverage of a bitmap-stem join against `_Suchka`'s real items was **15/89 base records (17%)** — nowhere near the gate, and wrong for most gear even where it "hit".

### What was built instead (approved before implementing)

A hybrid, both halves behind the unchanged `GameDb` seam:

- **Item identity and data — the game's own `.arz` archives** (`src/core/db/arz.ts`), keyed by record path, merged `database.arz` → `GDX1` → `GDX2` → `GDX3` last-wins. This is the post-v1 backend from the appendix below, pulled forward because nothing else can identify a save's items. It needed no new dependency: LZ4 *block* decompression is ~30 lines and `.arz` already stores the decompressed size.
- **Localization — GrimTools `l10n/en.js`** (~1 MB, 16,246 tags), which resolves 95.6% of all item name tags and 100% of the tags on real gear. The misses are dev placeholders (`*000_*` template records), DLC illusion transmutes and lore notes. This is now the **only** network fetch.

`itemdb.js` was briefly fetched for its `gameVersion` string and then dropped: 8.7 MB for one field, and the field is *wrong* — GrimTools reports the version of its own dump (`Version 1.3.0.0`) against a 1.3.0.6 install. The version now comes from a NUL-terminated `v1.3.0.6` marker in `Engine.dll`, which is unique in that binary under a version-shaped, NUL-terminated pattern; `readGameVersion` returns undefined rather than guessing if a future patch ever makes it ambiguous. (Steam's `appmanifest_219990.acf` only offers `buildid`, and `itemdb_diff.js` is 14 MB.)

Vendor catalogs also come from the `.arz` rather than GrimTools, contrary to the approved sketch: GrimTools' faction lists are `it####` ids that cannot produce record paths, and `DbItem.record` (plus Stage 4's icons) needs them. `factionmarket.tpl` → four `factiontier.tpl` tables → `marketStaticItems` gives the same stock with real record paths — 15 vendor factions, 1,100 items.

### Answers to the plan's open questions

- **Affix name coverage**: fully available, and from the game rather than a dump. Prefix/suffix records carry `lootRandomizerName`; 6,196 of 7,984 affix records are named. The unnamed 1,788 are all `records/items/lootaffixes/crafting/*` — the bonus a blacksmith rolls onto a crafted item, which has **no name in the game either** (its stats display inline). `GameDb.knowsAffix()` was added so "known but nameless" is distinguishable from "missing"; the resolver counts the former as resolved. No filename-tail fallback was needed.
- **Faction identity**: `records/game/gamefactions.dbr` is the authoritative roster, and record filenames are *not* a reliable guide — `factiongdx3_dread.dbr` is registered as the **Traps** faction and `factiongdx3_traps.dbr` as **The Dread**. Ids are `f<n>` from that roster, which is very likely the same index the save's faction array uses (worth confirming in Stage 5 — it would replace the guessed table in `src/core/save/factions.ts`).

### Deviations from the deliverables list

- `src/core/db/grimtools.ts` no longer normalizes an item DB; it downloads, sandbox-evaluates and zod-validates the dumps. Item normalization lives in `src/core/db/build.ts`, archive reading in `arz.ts`, install discovery in `gamefiles.ts`.
- Cache directories are keyed by a fingerprint of the archives' sizes and mtimes rather than by `gameVersion`, because the fingerprint is derivable **offline** — a cold start with a warm cache never has to ask the network what version it is. The version string is stored inside `db.json`.
- `DbItem.factionId`/`repTier` became `DbItem.vendors: { factionId, repTier }[]`. Several factions stock the same consumables and component blueprints; singular fields silently dropped the cheaper source.
- `ResolvedItem.base` is optional (the plan had it required), since an unresolvable record still has to produce a listing row.
- `iconPath` reads four fields, not one: `bitmap` (gear, augments), `artifactBitmap` (relics), `relicBitmap` (components), `artifactFormulaBitmapName` (blueprints).
- Localized text is stripped of the game's inline formatting escapes (`^k` tints tier-2 component names gold; `^n` is a line break) — `cleanText` in `build.ts`.
- Added `test/settings.test.ts` and a `README.md` (the plan asks for GrimTools credit in README/UI; there was no README).

### Numbers

`1.3.0.6` — 9,878 items, 7,984 affixes (6,196 named), 29 factions (15 with vendors, 1,100 items stocked), 927 blueprints. Cold build ≈ 3 s plus a single ~1 MB download; warm start ≈ 0.4 s and zero network (asserted by a test with `fetch` stubbed to throw).

### Notes for later stages

- Stage 4 gets `iconPath` as an in-archive `.tex` path and will need an `.arc` reader; once that exists, `Text_EN.arc` removes the last GrimTools dependency.
- `db.json` carries raw DBR stat keys per item (asset paths and zeros dropped), which is what Stage 5's context document wants.

## Appendix — post-v1 .arz backend pointers (partly built in Stage 3 — see Outcome)

Own-parse path for offline independence: `.arz` = header + string table + LZ4-compressed records (fields: u16 type, u16 count, u32 keyId, values; types 0=int 1=float 2=string-idx 3=bool). Merge `database/database.arz` → `gdx1/GDX1.arz` → `gdx2/GDX2.arz` → `gdx3/GDX3.arz` last-wins (model: https://github.com/gregates/lib-gddb). Record schemas: glacie `.gxmpi` templates (https://github.com/lixiss/glacie). Vendor stock: `factionmarket.tpl` records have exactly 4 tier slots (`friendly/respected/honored/revered*Table`) → `factiontier.tpl` records; `marketStaticItems` = deterministic augment/blueprint stock. Localization from `resources/Text_EN.arc`. Icons from `resources/Items.arc`: `.tex` = 12-byte header (`TEX\x02`, u32 size) wrapping a DDS whose magic reads `DDSR` — replace with `"DDS "`, uncompressed 32bpp BGRA at offset 128, keep alpha.
