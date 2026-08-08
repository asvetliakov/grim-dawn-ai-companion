# Stage 4 — Icon service

## Goal

Turn `DbItem.iconPath` into per-item PNG files by slicing the GrimTools sprite sheet, cached on disk. CLI `icon` command for spot checks. This is what the Electron UI (Stage 7) serves through its `gdicon://` protocol.

## Context

Stage 3 caches the DB under `~/Library/Application Support/gd-companion/cache/<gameVersion>/` and gives every `DbItem` an `iconPath` like `items/enchants/enchantm_black.png`. GrimTools serves all item icons as one sprite sheet with a CSS position map (verified 2026-08):

- Sprite: `https://www.grimtools.com/db/itemdb/itemdb.webp` (~5.5 MB, webp)
- Positions: `https://www.grimtools.com/db/itemdb/itemdb.css` (~471 KB)
- Class-name mapping (deminified from their db.js):
  `className = "itemdb-" + iconPath.replace(/\//g, "_").replace(/[()]/g, "").replace(/\.png$/, "")`
  e.g. `items/enchants/enchantm_black.png` → `.itemdb-items_enchants_enchantm_black` → `background-position:-2656px -1568px; width:32px; height:64px` → crop rect `{left:2656, top:1568, width:32, height:64}`.

Same etiquette as Stage 3: download once per game version alongside the DB, cache raw files, never commit them.

## Deliverables

```
src/core/icons/sprite.ts
  # ensureSpriteAssets(cache): download webp+css if absent
  # parseCssRects(css): Map<className, {x,y,w,h}>  (regex over .itemdb-* rules; positions are negative px)
  # getIconPng(iconPath, cache): Promise<string>   # slices with sharp on miss → cache/<ver>/icons/<flattened>.png, returns abs path
src/cli/index.ts   # add `icon <iconPathOrRecord> [-o out.png]` and `icon --check-all` (batch over both chars' resolved items)
test/icons.test.ts
```

Dependency: `sharp@^0.34` (darwin-arm64 prebuilds exist for Node 24 — no build toolchain needed). Sharp must only ever be imported from core/CLI/Electron-main code, never the renderer.

Implementation notes:
- Slice: `sharp(spritePath).extract({left, top, width, height}).png().toFile(dest)`.
- Icons vary in size (1×1 up to 2×4 game cells ≈ 32×32…64×128 px) — take w/h from the CSS, don't assume.
- Missing class in CSS map → return `undefined` (caller falls back to text) and count it; don't throw.

## Acceptance criteria

1. `npm run cli -- icon "items/enchants/enchantm_black.png" -o /tmp/test-icon.png` writes a PNG; `open` it — it's the augment icon (dark orb), not a mis-cropped neighbor; non-square icons (a 2-handed weapon from _Suchka's gear) crop correctly.
2. `npm run cli -- icon --check-all`: resolves icons for **all** equipped + inventory + stash items of both characters; reports `N/N found` or lists missing CSS classes (gate: 0 missing for equipped items; list any inventory misses).
3. Second run performs no network and no re-slicing (cache hit); unit-tested with mocked fetch.
4. `npm test` + `npm run typecheck` green; `git status` clean of image/cache files.

## Verification

```bash
npm test && npm run typecheck
npm run cli -- icon "items/enchants/enchantm_black.png" -o /tmp/test-icon.png && open /tmp/test-icon.png
npm run cli -- icon --check-all
```

## Outcome

**Built and verified 2026-08-08. All four acceptance criteria pass — `icon --check-all`
reports 148/148, and a whole-database sweep finds 3,840 of 3,844 icons. The source is
not the one this plan specified.**

### GrimTools' sprite sheet was never needed

The plan predates Stage 3's pivot. It assumes `DbItem.iconPath` is a GrimTools
`.png` path that keys into `itemdb.css`; since Stage 3, `iconPath` is the DBR
`bitmap` field — an **in-archive `.tex` path** like `items/enchants/enchantm_black.tex`.
Grim Dawn ships those textures in `resources/Items.arc`, so the sprite sheet, its
471 KB CSS position map and the whole class-name derivation are unnecessary. Stage
3's Outcome and the runbook backlog both anticipated this ("Stage 4 needs an `.arc`
reader for icons anyway").

Icons now involve **no network at all**, and one fewer many-to-one join: GrimTools'
`bitmap` field is shared across records, so a sprite lookup would have shown the
wrong art wherever records reuse a filename.

### What was built

- **`src/core/db/arc.ts`** — reader for the game's `.arc` asset archives, sibling to
  `arz.ts` and sharing its LZ4 block decompressor. Header at the tail: chunk table,
  string table, then 44-byte file entries; chunks whose compressed and decompressed
  sizes match are stored verbatim. Only the tables are read up front (~650 KB against
  a 454 MB `Items.arc`), so extracting one icon reads one icon's worth of bytes.
  `resources/Text_EN.arc` is now one call away — the last GrimTools dependency.
- **`src/core/icons/tex.ts`** — `.tex` → RGBA. Twelve-byte `TEX\x02` wrapper, then a
  DDS whose magic reads `DDSR`; the pixel-format masks are all zero and the byte
  order is fixed **BGRA**, verified by decoding a red and a blue augment and looking
  at them.
- **`src/core/icons/png.ts`**, **`src/core/icons/index.ts`** — PNG encoder and the
  cache-backed service; `flatten()` collapses the path so a record cannot address
  anything outside the cache directory.
- CLI `icon <path|record> [-o file]` and `icon --check-all`; `resolve`'s character
  loading was factored into `resolveAllCharacters` and shared.

### Deviations from the deliverables list

- **`sharp` was not added.** Its job here would have been `extract()` on a sprite
  sheet, and there is no sprite sheet — each `.tex` *is* one icon, so the only
  remaining image operation is "wrap decoded pixels in a PNG", which `node:zlib`
  does in 60 lines. That also keeps a native module out of Stage 7: sharp needs an
  Electron-ABI rebuild, and the constraint that it must never reach the renderer
  stops being a constraint anyone can trip over. `package.json` is unchanged —
  Stage 4 added **zero dependencies**.
- `src/core/icons/sprite.ts` and `parseCssRects` do not exist; `ensureSpriteAssets`
  has no analogue because there is nothing to download.
- Archives are searched **gdx3 → gdx2 → gdx1 → base**, matching the `.arz` merge, so
  an expansion that re-arts a base item wins. The first path segment names the
  archive (`items/…` → `Items.arc`, `ui/…` → `UI.arc`), matched case-insensitively
  because the records and the filenames disagree on case.
- `icon --check-all` also reports records that declare **no icon at all** (one:
  the "Quest - Old Arkovia" lore note), which is a different finding from art that
  is missing.

### Numbers

- `icon --check-all`: **148/148** distinct icons across both characters' equipped,
  inventory, stash and transfer items, plus every fitted component and augment.
  Zero missing, including zero for equipped.
- Whole database: **3,840 / 3,844** icon paths resolve (99.9%), 3.3 s cold for all
  of them, ~15 MB of PNGs. The four misses are unreachable records — two
  `BASE BLANK EPIC SWORD` templates and three `records/items/enemygear/*` monster
  drops — whose art was removed from the archives.
- **Zero decode failures**: no item icon anywhere in the database is DXT-compressed
  (3,843 at 32bpp, one at 24), which is why no block decompressor was written. A
  compressed texture reports `UnsupportedTextureError` and the caller falls back to
  text rather than crashing.
- Second run: 0 extracted, 148 cached, ~0.5 s including the database load.

### Notes for later stages

- Stage 7's `gdicon://` handler is `createIconService()` plus `getIconPng`. Nothing
  in `src/core/icons/` is native, so the "sharp only in Node contexts" rule has
  nothing left to bite on.
- `ArcArchive` + `Text_EN.arc` would drop the GrimTools localization fetch and make
  the tool fully offline. That is now a small job, not a stage.
