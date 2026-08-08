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

## Appendix — post-v1 .arz backend pointers (do not build now)

Own-parse path for offline independence: `.arz` = header + string table + LZ4-compressed records (fields: u16 type, u16 count, u32 keyId, values; types 0=int 1=float 2=string-idx 3=bool). Merge `database/database.arz` → `gdx1/GDX1.arz` → `gdx2/GDX2.arz` → `gdx3/GDX3.arz` last-wins (model: https://github.com/gregates/lib-gddb). Record schemas: glacie `.gxmpi` templates (https://github.com/lixiss/glacie). Vendor stock: `factionmarket.tpl` records have exactly 4 tier slots (`friendly/respected/honored/revered*Table`) → `factiontier.tpl` records; `marketStaticItems` = deterministic augment/blueprint stock. Localization from `resources/Text_EN.arc`. Icons from `resources/Items.arc`: `.tex` = 12-byte header (`TEX\x02`, u32 size) wrapping a DDS whose magic reads `DDSR` — replace with `"DDS "`, uncompressed 32bpp BGRA at offset 128, keep alpha.
