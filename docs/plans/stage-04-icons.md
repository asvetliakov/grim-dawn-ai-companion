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
