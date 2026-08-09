# Stage 7A — Electron shell, character window, inventory & tooltips

## Goal

The app's read-only half: an Electron + React window styled with the game's own UI art, showing the selected character exactly the way the in-game character screen does — equipment doll with icons, stats side panel (attributes, OA/DA, resistance matrix with the difficulty penalty, armour, speeds), main inventory + extra bags underneath, tabs for the personal stash and the transfer stash, and a GrimTools-style hover tooltip on every item. No AI yet (Stage 7B) and no file watcher (Stage 7C) — a Refresh button plus refresh-on-window-focus stand in.

## Context

Everything below the UI works from the CLI (Stages 1–6C, all in Electron-free `src/core/`). This stage adds the Electron shell as a thin consumer and the read-only views. Two later stages complete the app: 7B (AI advice integration — the IPC contract for it is *defined* here but implemented there), 7C (save watcher + settings polish).

**Styling decision (investigated, settled):** Grim Dawn's UI is not web tech — zero HTML/CSS/JS in the install; it's the proprietary engine's `Widget.dll` painting `.tex` sprites. But the art itself is fully reachable with code we already have: `resources/UI.arc` (242 MB, 3,010 entries; gdx1/2/3 ship overlay `UI.arc`s searched in the same gdx3→gdx2→gdx1→base order as everything else) holds the window frame, per-slot equipment placeholders, 9-slice borders, buttons and bag tabs. ~99.4% of those entries are uncompressed 32/24bpp that the existing `decodeTex` accepts (the DXT-compressed rejects are decorative art we don't need — main-menu skies, quest-log glyphs). `getIconPng('ui/character/….tex')` works **unchanged**: the first path segment names the `.arc`. So the app uses authentic game chrome loaded at runtime from the install — with a plain dark-CSS fallback per texture, and **nothing game-derived ever committed** (the standing gitignore rule).

Useful chrome verified present in `UI.arc`:

- `ui/character/character_windowborderimage.tex` (330×563 — the character window frame)
- `ui/character/character_equipslot{head,chest,legs,feet,hands,shoulders,waist,neck,fingers,medal,relic,handleft,handright}.tex` — one placeholder per doll slot
- `ui/character/character_buttonweaponswap{up,over,down}.tex`, `ui/character/character_inventorybagtab{up,over,down}.tex`
- 9-slice panel chrome: `ui/generic/background_bordercorner{upperleft,upperright,bottomleft,bottomright}.tex`, `background_borderedge{top,bottom,left,right}.tex` (8×8), `background_borderfiller.tex` (4×4); buttons `ui/generic/buttonthin01_{up,over,down,disabled}.tex`

All `.tex` there are `TEX\x02` + `DDSR`, mip-free.

## Stack & scaffolding

Dependencies (all pure JS — the no-native-modules rule stands, so no Electron ABI rebuilds):

```
electron@^38  electron-vite@^4  vite@^7  @vitejs/plugin-react@^5
react@^19  react-dom@^19  @types/react@^19  @types/react-dom@^19
@floating-ui/react@^0.27
```

(`react-markdown`/`remark-gfm`/`lucide-react` arrive in 7B; `chokidar` in 7C.)

- Script: `"dev": "electron-vite dev"`; `electron.vite.config.ts` at the repo root.
- New directories:
  - `src/main/` — `index.ts` (lifecycle; BrowserWindow ~1200×860, resizable; CSP), `state.ts` (session state), `ipc.ts` (handler registration), `protocol.ts` (`gdicon://`)
  - `src/preload/index.ts` — contextBridge exposing the typed API only
  - `src/renderer/` — `index.html` + `src/` React components + `tsconfig.json`
  - `src/shared/` — the IPC contract; **types and pure functions only**, no node imports, must compile under both tsconfigs
- tsconfig split: root `tsconfig.json` `include` gains `src/main`, `src/preload`, `src/shared`; new `src/renderer/tsconfig.json` extends root with `"lib": ["ES2023","DOM","DOM.Iterable"]`, `"jsx": "react-jsx"`, `"types": []`, including `src/renderer/**/*` and `src/shared/**/*`. `"typecheck"` becomes `tsc --noEmit -p tsconfig.json && tsc --noEmit -p src/renderer/tsconfig.json`. Vitest stays node-env; tests import only core/shared.
- Security: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. CSP in `index.html`: `default-src 'self'; img-src 'self' gdicon:; style-src 'self' 'unsafe-inline'`. The renderer never imports node builtins.
- `src/core/` stays Electron-free; `src/main` is a thin consumer, exactly like the CLI.

## Core adjustments (all additive)

### 1. Structured position — `ItemPosition` on `ResolvedItem` (`src/core/resolve.ts`)

The UI needs numeric grid coordinates; today `resolveCharacter` collapses placement into the human string `location` (`"bag 1 (3,2)"`). Add:

```ts
export type ItemPosition =
  | { kind: 'equipment'; slot: number }                        // EquipSlot 0..11
  | { kind: 'weapon'; set: 1 | 2; hand: 'main' | 'off' }
  | { kind: 'inventory'; sack: number; x: number; y: number }  // i32 as stored
  | { kind: 'stash'; tab: number; x: number; y: number }       // Math.round(float)
  | { kind: 'transfer'; tab: number; x: number; y: number }    // Math.round(float)
  | { kind: 'materials' };
```

populated in `resolveCharacter` beside each existing `location` string (the walk at resolve.ts:372–413). **Do not change walk order or the `location` strings**: dossier ids get letter suffixes on hash collision in document order (`assignIds`, `src/core/context/builder.ts:174`), and the context document must stay byte-identical — that id stability is what 7B's advice-to-item join relies on. Remember `transfer.gst`/stash coords are floats, inventory coords are i32 (the classic porting bug); `Math.round` the floats, matching the existing `position()` display helper.

### 2. Icon dimensions — `IconService.getIconInfo` (`src/core/icons/`)

Item grid footprints (1×1 up to 2×4 cells) are stored **nowhere** in the game DB — the icon texture is the only source, at 32 px per cell. Add:

```ts
export interface IconInfo { pngPath: string; width: number; height: number; cellsW: number; cellsH: number }
getIconInfo(iconPath: string): Promise<IconInfo | undefined>;   // beside getIconPng
```

`cells = clamp(round(px / 32), 1, 4)`. The decode path already has `width`/`height` from `decodeTex`; the cache-hit path reads the PNG IHDR (width/height are big-endian u32 at bytes 16–24) via a new `readPngSize(path)` in `src/core/icons/png.ts` (the CLI's private `pngSize` at `src/cli/index.ts:517` does this already — promote it). Missing icon → caller falls back to 1×1.

### 3. Extract the session composition — `src/core/session.ts`

The CLI's `contextFor` (`src/cli/index.ts:980`) plus its private `readSave` (:76) and `accountFiles` (:420) are exactly what the Electron main process needs; move the logic into core:

```ts
export interface SnapshotOptions { character?: string; difficulty?: Difficulty; maxTokens?: number; perGroup?: number }
export interface CharacterSnapshot {
  character: string; savePath: string; save: CharacterSave; difficulty: Difficulty;
  resolved: ResolvedCharacter; aggregate: CharacterAggregate; input: ContextInput; doc: ContextDoc;
}
export function readSave(path: string): Buffer;
export function accountFiles(saveDir: string): AccountFiles;
export function loadSnapshot(db: GameDb, settings: ResolvedSettings, opts?: SnapshotOptions): CharacterSnapshot;
```

`loadSnapshot` throws typed errors (no-characters, bad difficulty); the CLI's `contextFor` becomes a thin wrapper (catch → `console.error` + `process.exit(1)`). Composition is exactly today's: `parseGdc(readSave(path))` → difficulty = explicit ?? `settings.difficultyOverride` ?? `save.difficulty` → `resolveCharacter(save, accountFiles(saveDir), db)` → `aggregateCharacter(save, db, difficulty)` → `buildContextDoc`. CLI output must not change.

### 4. UI snapshot builder — `src/core/view.ts`

Everything crossing IPC is a structured-clone-safe DTO — no `Map`s, no `GameDb`, no `ResolvedItem`. One pure transform, unit-testable without Electron:

```ts
export async function buildUiSnapshot(snap: CharacterSnapshot, icons: IconService): Promise<UiSnapshot>;

export interface UiItem {
  docId: string; display: string; rarity: string;      // renderer owns the color palette
  iconPath: string | null; cellsW: number; cellsH: number;
  position: ItemPosition; source: ItemSource; stackCount: number;
  tooltip: UiTooltip;
}
export interface UiTooltip {
  title: string; rarity: string; typeLine?: string;
  affixes: string[]; blocks: { heading?: string; lines: string[] }[];
  component?: { name: string; lines: string[] }; augment?: { name: string; lines: string[] };
  requirements?: string[]; grantedSkills?: string[];
}
export interface UiGrid { width: number; height: number; items: UiItem[] }
export interface UiSnapshot {
  character: string; level: number; className?: string; difficulty: Difficulty;
  alternateWeaponSetActive: boolean;
  equipment: (UiItem | null)[];                        // length 12, EQUIP_SLOT_NAMES order
  weaponSets: [(UiItem | null)[], (UiItem | null)[]];  // [main, off] × sets 1 and 2
  bags: UiGrid[]; personalStash: UiGrid[]; transferStash: UiGrid[];
  stats: UiStats;
}
```

- Tooltips are **precomputed here** with `itemStatBlocks` (`src/core/context/filters.ts:125`) + `formatStats` (`src/core/context/statfmt.ts:365`) — the renderer is a dumb string painter and tooltip lines are guaranteed identical to the context document's formatting (every stat named, gendered-locale cleanup, the works). Requirements render via the same phrasing `describeRequirements` uses.
- `UiStats` comes from `CharacterAggregate`: level/class, attributes, health/energy, OA/DA, the resistance matrix rows with the active difficulty's per-type penalty (it is **not uniform** — Ultimate is 0 to Physical), armour per body part, attack/cast/movement speed against their caps.
- `docId` must be the **document id** (from `ContextDoc.itemIds` / `itemsById`), not raw `ResolvedItem.id` — they differ on hash collision, and 7B joins advice by doc id.

### 5. Grid dimensions — `src/core/grid.ts`

Personal-stash and transfer-stash tabs carry `width`/`height` in the save — use them. **Inventory sacks store no dimensions** (only the item list). Add:

```ts
export interface GridDims { width: number; height: number }
export function sackDims(items: PositionedItem[], index: number, cells: (i: PositionedItem) => GridDims): GridDims;
```

returning `max(constant, item extents)` with constants MAIN_BAG 12×8 (sack 0) and EXTRA_BAG 8×8 — **the constants are a best guess and must be verified against the in-game inventory screen during this stage** (acceptance criterion 4); extent-growth (`max(x + cellsW)`, `max(y + cellsH)`) guarantees nothing renders outside the grid even if a constant is wrong.

## IPC contract — `src/shared/ipc.ts`

Defined **completely** in this stage, advise channels included, so 7B only implements. Preload exposes `window.gd: GdApi` via `contextBridge`; `src/main/ipc.ts` registers with a `registerHandlers(api: GdApi)` helper so a missed channel is a compile error.

```ts
export interface GdApi {
  getBootstrap(): Promise<Bootstrap>;
  getSnapshot(character?: string): Promise<UiSnapshot>;
  setActiveCharacter(name: string): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  refresh(): Promise<UiSnapshot>;
  startAdvise(req: { question?: string }): Promise<{ runId: string }>;  // implemented 7B
  cancelAdvise(runId: string): Promise<void>;                           // implemented 7B
  getAdviseStatus(): Promise<AdviseStatus>;                             // implemented 7B
  getLastAdvice(character: string): Promise<AdviseEnvelope | null>;     // implemented 7B
  onPush(cb: (e: PushEvent) => void): () => void;
}
export type PushEvent =
  | { type: 'advise-progress'; runId: string; phase: 'context' | 'asking' | 'repair'; elapsedMs: number }
  | { type: 'advise-done'; runId: string; envelope: AdviseEnvelope }
  | { type: 'advise-error'; runId: string; message: string }
  | { type: 'db-progress'; message: string }
  | { type: 'snapshot-invalidated' };
export interface Bootstrap {
  settings: Settings; characters: string[]; active?: string;
  chrome: Record<ChromeKey, string | null>;   // gdicon URL or null per chrome texture
}
export function gdiconUrl(texPath: string): string;
```

(7A ships `AdviseStatus`/`AdviseEnvelope` as type imports from core so the contract compiles; their behavior lands in 7B.)

Main-process state (`src/main/state.ts`): one mutable session `{ settings, db?, icons?, snapshot? }`. Invalidation: `gameDir`/`locale` change → drop db + icons and rebuild; `saveDir`/`activeCharacter`/`difficultyOverride` change or `refresh()` → rebuild snapshot only. `loadGameDb`'s `onProgress` forwards as `db-progress` pushes — **the first boot builds the database and the window must show that progress, not hang blank**.

## `gdicon://` protocol — `src/main/protocol.ts`

- URL shape: `gdicon://tex/<URL-encoded arc-relative tex path>` — e.g. `gdicon://tex/items/enchants/enchantm_black.tex` and `gdicon://tex/ui/character/character_equipslothead.tex`. **One namespace serves item icons and UI chrome**: both are arc-relative `.tex` paths and `getIconPng` already resolves the archive from the first segment.
- Register privileged (`{ scheme: 'gdicon', privileges: { supportFetchAPI: true, stream: true } }`) before `app.whenReady`; serve with `protocol.handle` returning the cached PNG (`Content-Type: image/png`, `Cache-Control: public, max-age=31536000, immutable` — honest because the cache dir is keyed by game fingerprint). Miss/undecodable → 404. Reject any decoded path containing `..` (defense in depth; `flatten()` already makes escapes unrepresentable).
- **Chrome textures are probed at startup, not error-handled per element** — CSS `background-image` has no error event. Main probes a fixed ~20-entry `CHROME_TEXTURES: Record<ChromeKey, string>` map (window border, the 13 equip-slot pieces, the 9-slice generic set, bag tab, weapon-swap buttons, `buttonthin01_*`) through `getIconPng` once; `Bootstrap.chrome` maps each key to its gdicon URL or `null`. The renderer sets CSS custom properties from the map; `null` → the dark-CSS fallback for that piece. No broken images, ever — and the probe pre-warms the PNG cache so first paint is cheap. `<img>` items still get an `onError` → CSS placeholder (rarity-tinted bordered box).

## Renderer — `src/renderer/src/`

State: plain React context + hooks — one window, one snapshot replaced wholesale on refresh; nothing heavier is justified. `SessionProvider` holds `{ bootstrap, snapshot, loading, error, refresh(), setCharacter(), updateSettings() }` and subscribes to `onPush` for `snapshot-invalidated` / `db-progress`.

```
App
├─ Header            character picker · difficulty override (Normal/Elite/Ultimate/auto) · Refresh · settings gear
├─ CharacterScreen
│  ├─ EquipmentDoll  absolute layout over the character_windowborderimage backdrop;
│  │                 per-slot background = character_equipslot*.tex; WeaponSetSwitch (I/II,
│  │                 active set marked from alternateWeaponSetActive)
│  └─ StatsPanel     level/class · attributes · health/energy · OA/DA · ResistMatrix
│                    (with difficulty penalty) · armour · speeds vs caps
├─ ContainerPanel
│  ├─ ContainerTabs  Inventory | Stash | Transfer
│  └─ ItemGrid[]     main bag + expandable extra-bag strip; stash/transfer tab strips
└─ TooltipLayer      @floating-ui/react portal: ItemTooltip
```

- Grid rendering: cell = 32 px as a single CSS var (`--cell`) so scaling is a one-line change. `ItemGrid` is `position: relative`, sized `width × var(--cell)`; the cell lattice is a `repeating-linear-gradient` (or the game's slot texture where available); items are absolutely positioned at `x·cell, y·cell`, sized `cellsW×cellsH` cells, `<img draggable={false}>`; `stackCount > 1` renders a bottom-right count label.
- Tooltip: `@floating-ui/react` (flip/shift/portal handle the screen-edge cases plain CSS gets wrong). Rarity-colored title from a renderer CSS-var palette keyed on the rarity string — `Common | Magical | Rare | Epic | Legendary | Quest`; the DB defines no colors, so pick hues matching the game (white/yellow/green/blue/purple respectively; Quest like the game's quest-item color).
- Refresh: the Refresh button and a `window` `focus` listener both call `refresh()` (cheap — one `.gdc` parse + resolve; the DB is untouched). This stands in for the watcher until 7C.
- Footer credit: "Item data & icons read from your Grim Dawn install — game data © Crate Entertainment."

## Acceptance criteria

1. `npm run dev` opens the window; a first boot (empty cache) shows DB-build progress rather than a blank screen.
2. Character picker lists the dirs under `save/main/`; `_Suchka` renders: 12-slot doll + both weapon sets with the I/II switch (active set marked), correct icons, rarity-colored names — compared against the in-game character screen.
3. Stats panel numbers match `npm run cli -- aggregates --char _Suchka` at the same difficulty: attributes, OA/DA, the full resistance matrix with penalty, armour, speeds vs caps.
4. Inventory tab: every item at its in-game grid position with the correct footprint; the main-bag/extra-bag dimension constants verified against the in-game inventory screen and corrected in `src/core/grid.ts` if wrong; stacks show counts; Stash and Transfer tabs use the save-carried tab dimensions.
5. Hover tooltip on any item: rarity-colored title, affix names, stat lines identical to the context document's formatting, component/augment blocks, requirements.
6. Game chrome loads through `gdicon://` (slot backgrounds and window border visible). With `gameDir` unset or wrong, the app still opens: CSS fallbacks everywhere, the existing `MISSING_GAME_DIR_MESSAGE` surfaced readably, no broken-image glyphs.
7. Refresh button and window focus re-read the save; the difficulty override re-renders the resistance matrix; settings persist across restarts (existing `saveSettings`).
8. `npm test` and `npm run typecheck` (both tsconfigs) green. New unit tests: `position` ↔ `location` agreement for every item on the fixture save; `getIconInfo` cell math + `readPngSize`; `sackDims` extent growth; `buildUiSnapshot` shape on the fixture save. `git status` shows no game-derived file (icons, `.tex`, PNGs) — the gitignore rule holds.

## Verification

```bash
npm test && npm run typecheck
npm run cli -- context --char _Suchka   # unchanged output — id stability proof
npm run dev                             # manual pass over criteria 1–7; screenshot for the record
```

## Outcome

Shipped, with the renderer redesigned mid-stage on the user's review. Everything
below the UI landed as planned; the two deviations are both in what the window
looks like, and both were the user's call after seeing the first build.

### Deviation 1 — the game's UI art is gone

The plan's central styling decision was to dress the window in `UI.arc` chrome.
It was built, it worked, and it was **dropped**: `character_windowborderimage`,
the 9-slice panel set and the bag tabs are cut for the engine's fixed layout, so
at the sizes this app uses they overlap and fight the content instead of framing
it. Item icons stay — they carry information; the frames were decoration bought
at the cost of legibility.

What went with it: `CHROME_TEXTURES`, `ChromeKey`, `EQUIP_SLOT_CHROME`,
`Bootstrap.chrome`, the startup probe in `state.ts`, `applyChrome` in the
renderer and every `--tex-*` custom property. `gdicon://` stays exactly as
designed — it just serves one namespace's worth of item icons now.

### Deviation 2 — no paper doll; a current → proposed comparison instead

The doll's arrangement exists to wrap a rendered character, and there is no
character here, so the plan's layout spent its middle third on nothing. It is
replaced by `LoadoutPanel`: one full-width row per slot — label, what is
equipped, an arrow, and what the advisor proposes — with the component and
augment as their own small faces underneath each item (`UiSocketable` gained an
`iconPath` for it). Until an advice run exists the proposal column reads
*locked* rather than being hidden, because an empty column that is obviously
waiting says what the app is for.

Two columns of slot-pairs were tried first, as the user sketched. Grim Dawn item
names run to five words and every one of them ellipsised at half width, so it is
one column. The window is now 1920×1080 with a 15 px base and
`font-smoothing: auto` (a serif at 12–15 px on a dark ground reads washed out
when it is thinned).

This pulls presentation for Stage 7B's data forward into 7A — the per-slot
verdict join, the projected-resistance column with coloured deltas, the summary
/ key-moves / verdict table, the hold list. **No new contract was invented for
it:** all of it reads `AdviseEnvelope` as Stage 6C already defines it, and in
7A the `getLastAdvice` channel is registered and answers `null`, so the whole
thing renders locked against a live save. 7B supplies the envelope; the UI does
not change.

New in the bargain, and the reason the two halves share a window:
**hovering a proposal lights that item up wherever it actually lives**, marks
the container tab holding it, and clicking flips the panel to that tab
(`highlight.tsx`). Finding the item by hand across four containers and a dozen
tabs was the tedious half of acting on advice.

### Verification moved to Storybook + Playwright

At the user's suggestion, and it paid for itself immediately: `npm run
storybook`, `npm run stories:shoot` (screenshots at 1920×1080) and `npm run
stories:check` (11 behaviour assertions — highlight, reveal, tooltip, locked
column, sparse character). The UI is developed against a **synthetic** fixture
(`src/renderer/src/fixtures.ts`) whose every name and stat is invented, because
a fixture cut from a live save is game-derived data and could not be committed;
it also makes the screenshots deterministic. `icons.tsx` is the seam that makes
this possible — the app resolves art through `gdiconUrl`, the stories through a
generated SVG swatch.

### Acceptance criteria

1–2, 6–8 met. Criterion 3 (stats match `aggregates`) verified line by line
against `npm run cli -- aggregates --char _Suchka`: attributes, OA/DA, all ten
resistance rows with the per-type penalty, six armour parts with the weakest
flag, absorption 89.6%, and all three speeds against their caps. Criterion 5
verified against the context document — the Chest tooltip is character-for-
character §5's block for the same item.

**Criterion 4's in-game comparison was not possible** (the game runs under
CrossOver and screen capture is TCC-blocked in this environment), so the bag
constants were settled from the data instead, which turned out to be stronger:
`_Suchka`'s main bag occupies **96 of 96 cells with zero overlaps** — a
perfectly tiled 12×8 — an extra bag 62 of 64, and the game's own
`character_inventoryextrapanelimage.tex` is 258×259, i.e. exactly 8×8 cells of
32 px plus a border. Across both characters' bags, stash tabs and transfer tabs
there is not one overlapping or out-of-bounds cell, which is a joint proof of
the footprint arithmetic (icon-derived) and the coordinates (save-derived).
`test/view.test.ts` asserts it. A wrong constant still cannot lose an item:
`sackDims` grows the grid to cover its contents.

### Notes for later stages

- **`ELECTRON_RUN_AS_NODE=1`** in a shell makes `require('electron')` return the
  binary's *path* and the app dies on `protocol` being undefined. It is an
  agent-harness artifact, not a code problem — launch with `env -u`.
- **Main and preload are both CommonJS `.cjs`.** Two independent reasons: an ESM
  preload requires `sandbox: false`, and Node's CJS export detection cannot see
  named exports through Electron's module shim, so an ESM main dies on
  `import { BrowserWindow } from 'electron'` before it runs a line.
- **The renderer compiles with `types: []`**, which makes "no Node import may
  reach the renderer" a compile error rather than a convention. Three small
  moves were needed to satisfy it, all of them improvements: `ItemPosition` /
  `ItemSource` to `save/types.ts`, `PlanWarning` to `ai/provider.ts` (it is part
  of the plan's public vocabulary, like `VerdictRow`), and the settings zod
  schema to `settings-schema.ts`. The DTOs themselves live in `src/shared/`,
  which `src/core/view.ts` implements against.
- `npm run cli -- context --char _Suchka` is **byte-identical** before and
  after — the id-stability proof the advice join depends on.

### Follow-up pass (same session, second review)

Fourteen small items from a second look at the screenshots, most of them
legibility. The ones with a reason worth keeping:

- **Typeface: Inter Variable, not the serif and not Montserrat.** Nearly
  everything on screen is a dense number in a narrow column — six armour
  ratings, ten resistances against six columns each, three speeds against their
  caps. Inter is drawn for that: tall x-height that survives 12 px, unambiguous
  `1/l/I` and `0/O`, and real tabular figures, which are what keep a column of
  numbers aligned rather than merely near each other. Montserrat is a geometric
  display face — wide, low-contrast between similar glyphs, and at table sizes
  it costs both room and legibility. Swapping is one line (`--font`).
- **Secondary text went up a point and two shades.** It sat at `--ink-faint` on
  `--bg-panel`, which reads as *disabled* rather than as supporting text.
- **Stat lines are coloured by damage type** (`statColors.ts`). The colour is
  recognised from the finished string, which is only safe because Stage 6C made
  "every stat reference names its kind" a mechanical check — `Fire Resistance`
  and `Fire Damage` are both spelled out and neither can be mistaken for the
  other. The palette is spread deliberately around the wheel: the game crowds
  fire, chaos, bleeding and vitality into one warm corner, so they are pulled
  apart into orange / red / rose / violet-magenta.
- **Three columns, responsive.** Loadout · sheet · containers at ≥1600; the
  containers drop under the sheet below that, sharing its height 3:2 (an `auto`
  first row is exactly how they ended up below the fold and invisible); one
  column below 1180. The sheet's column is **fixed at 460 px** rather than
  fluid — a resistance table stretched across half a screen is harder to read
  across, not easier, and the width it gives up is what buys the third column.
- **The panes did not scroll in Storybook.** Not a bug in the app: Storybook's
  preview wrapper is height-less, so a `height: 100%` chain collapses to its
  content. The decorator in `.storybook/preview.ts` pins the root to the
  viewport, and `check-stories.mjs` now asserts the loadout pane both overflows
  *and* moves when scrolled.
- **The template class is humanised for the UI only** — `ArmorProtective_Head`
  → "Head Armour". The context document keeps printing the raw class, because
  its bytes are the id-stability contract.
- **Quest items that are also reagents say both.** Ancient Heart and Dynamite
  are classed `QuestItem` by the game *and* live in the crafting store; the type
  line now reads `Quest · Quest item · in the crafting store`. Picking one would
  have been a guess.
- Components and augments get their own tooltip rather than the host item's,
  and are hoverable from the loadout, the materials list and the slot label.
- The materials list sorts components ahead of raw materials and states what
  each one does — forty names alone means hovering forty times.
- Advice rows highlight **both** items they name; the highlight is a set now,
  not a single id.
- Run advice sits top-right in the header as well as in the advice panel.
- Long names ellipsise everywhere and the tooltip carries the whole thing;
  the fixture now includes an 80-character name to keep that honest.

Stories grew to 11 (adding first-boot, the unmet-requirement tooltip, the
socketable tooltip and the materials list); `stories:check` grew to 33
assertions, including the three responsive widths.

### Third pass (same session): socket moves, the answer tab, measured columns

Twelve more items from a third review. What is worth keeping:

- **A socket move is a proposal, not a note.** Four of the seven verdicts
  (`ADD-COMPONENT`, `SWAP-COMPONENT`, `RE-AUGMENT`, `BUY-AUGMENT`) keep the item
  and change what it *carries*, and the proposal column was rendering them as
  the bare words "ADD-COMPONENT Seal of Might" — which made the cheapest
  upgrades in the game look like an error message. They now render as a
  socketable face: art, name, its own stats on hover, the verdict, and — for an
  extraction — **what it destroys**, stated in the face because the Inventor
  recovers the item *or* the component and that cannot be undone.
- **This needed a new piece of contract.** A proposed socketable is installed
  nowhere, so there is no item to read its stats off. `UiSnapshot.socketables`
  is the dossier's own socketable table by id (194 on `_Suchka`), and
  `UiSocketable.id` puts the same id on the installed copy — one id serves the
  worn one, the loose one and the proposed one, which is exactly the join
  "take that out of this and put it in here" needs. Built from
  `snap.doc.socketablesById`; the ids are reserved against item ids upstream, so
  nothing answers to both, and `view.test.ts` asserts that.
- **The columns are measurements, not fractions.** The sheet is **540 px**
  because the resistance table is 506 wide once the projection column exists and
  the panel adds 32 of padding. The containers are **625 px** because a stash tab
  is 19 cells of 32 px plus padding — a column narrower than its widest
  container scrolls sideways forever. The loadout takes the remainder (691 at
  1920), which is the right way round: it is the only pane that reads better
  wide and still works narrow, because its long names ellipsise into a tooltip.
  The three-column breakpoint moved to 1860 accordingly, and the two-column
  arrangement widens its shared column to 625 for the same reason.
  *The containers column is not slack — the Inventory tab is a 12×8 bag in a
  column sized for a 19-wide stash.*
- **The model's own prose has a tab.** `answer` is the human product of a run
  and was being carried and never shown. `markdown.ts` is a tokenizer for the
  subset the prompt asks for (ATX headings, both list kinds, pipe tables,
  blockquotes, fences, rules, inline emphasis/code/links); `Markdown.tsx` paints
  the tree. It is a tree and not HTML on purpose: **every leaf is text and React
  puts text in a text node**, so an answer cannot inject markup into the window
  — true by construction rather than by escaping. Two things it had to learn
  from the first render: a hard-wrapped list item continues on its indented next
  line (otherwise the tail of every numbered item breaks out into a paragraph),
  and **type colour applies to table cells only** — `statColors` recognises a
  *stat line*, and a paragraph that says "Bleeding" once is not one; colouring
  the sentence red made an argument look like a warning.
- **Two marks, not one.** The highlight follows the pointer; the *actionable*
  set stands still and holds every id the plan asks you to act on — items to
  equip, items to hold, and the host an extraction destroys. Drawn as a corner
  flag rather than a second border, so a cell can be both at once; the container
  tab carries the count, because "there are three in here" is the reason to open
  it. Without it, finding the six items that matter in a stash of two hundred
  means hovering the advice table row by row.
- **Armour said the wrong thing twice.** The character-wide `+482 flat, +17%`
  sat as a note *between* the six body parts and the Absorption row, which
  invited exactly the reading it got: that it applies to absorption. It is
  `(piece + flat) × (1 + %)` **per part**, so it is now on the heading —
  "per body part — each +482 then ×1.17" — said once, about the list it governs.
  The `weakest` part is a red tag rather than a word at the end of a dim detail
  line, and the paragraph explaining that the engine rolls one part per hit
  moved onto the heading's `title`: it is a fact about the engine that never
  changes, and a paragraph of it above six numbers is read once and skipped
  forever after.
- **The component block inside an item tooltip was colourless.** A rule written
  for the granted-skill block (`.tooltip-socketable .tooltip-line { color:
  inherit }`) was flattening every component stat to the body colour — the right
  fix applied to the wrong block. Granted skills keep theirs: the point of that
  block is that it is a *skill*, whatever damage type its stats mention.
- **The component chip listens on `mouseover`, not `mouseenter`.** `mouseover`
  bubbles from whichever child the pointer is actually over, so arriving at the
  name — from the icon, from the item, from anywhere — re-asserts the
  socketable's tooltip instead of leaving whatever the last leave handler did
  standing. It also gained the `onMouseLeave` it never had.
- **Scrollbars are styled.** macOS overlay scrollbars are invisible until you
  scroll and then arrive as a bright grey slab over a dark panel. These are
  always present and always quiet.
- The sheet's row labels carry the same type colours as the tooltips, so a
  resistance row and a stat line are recognisably about one thing.

Stories grew to 13 (`Loadout — component & augment moves`, `Advice — full
answer`); `stories:check` grew to 56 assertions; `test/markdown.test.ts` adds 7.
`npm run cli -- context --char _Suchka` is **still byte-identical**.

**Deferred to 7B:** streaming the answer as it arrives, and animating the tab
while a run is in flight. Both need the live advise plumbing 7A deliberately
stubs.

### Fourth pass (same session): the proposal is the same item

Six items. Three changed a contract rather than a stylesheet:

- **The whole item face is the hover target**, not the 46 px of icon in it. The
  name is what the eye lands on and what the pointer goes to; requiring the icon
  made the tooltip read as broken. Both the face and the socket chips listen on
  **`mouseover` rather than `mouseenter`** — `mouseover` bubbles from whichever
  child is under the pointer, so moving icon → chip → name re-asserts the right
  subject at every step, where `mouseenter` fires once on the way in and never
  again. The chip has no leave handler on purpose: leaving it for the name is a
  `mouseover` on the face, and a `hide` here would race that. `TooltipProvider`
  returns the previous subject when nothing changed, so the extra events cost no
  re-renders.
- **A socket move proposes the same item, with its new socketable in it.** The
  previous pass rendered the lone component, which was better than a sentence
  but still asked the reader to assemble the result in their head — the question
  is "what will this slot look like", and the answer is an item. `withSocketable`
  derives a `UiItem` copy with the one socket replaced, so the tooltip is right
  for free: same component, same shape, no second rendering path to keep in
  agreement. The socket notes carry the consequences, which is where a reader
  hovering a proposal will look for them — *replaces X, the old component is
  destroyed*; *extracted from Y, which the extraction destroys*; *soulbound
  while the augment is applied*. Only the socket that changes is marked.
- **HOLD was being used as a status, and is now required to be a
  recommendation.** Every candidate failing a requirement is listed in §12 so a
  threshold can be costed against everything it unlocks — and the model read
  that as a to-do list, marking HOLD on over-levelled items whether or not they
  beat what the character was wearing. Three changes: the prompt says outright
  that being unequippable is *not* a reason to hold ("a hold says: on the day
  the threshold is met you will put this on"); the plan's `hold[]` gained
  `slot`, `beats` and `gains`; and `checkPlan` reports **`unjustified-hold`**
  when a hold cannot say which slot it is for, what it displaces, or what it
  wins by — plus the degenerate case of an item held to replace itself. The
  fields are optional in the schema and required by the check, so an older
  stored answer still parses. The repair loop gets one shot at fixing it.
  *The mechanical half is unit-tested; the prompt half needs a live run to
  confirm.*
- **The window is sized against the work area, not the screen.** A 1920×1080
  monitor does not have 1080 rows to give — the menu bar and Dock have already
  spent some — so a window asked for the full height opens with its footer
  underneath the Dock. `startingSize` (in `src/main/window-size.ts`, importing
  nothing, so it is testable) takes `min(design, workArea − margin)` and a
  `max` against the minimum: a larger monitor still opens at the size the layout
  was drawn for rather than filling the screen, and a screen too small overflows
  rather than collapsing. Verified live: this machine reports a work area 31 px
  shorter than the screen.

**On the Rainbow Filter (asked: can we take its colours?).** No — there is
nothing there to take, and it is not for want of a licence. The tool
([WanezGD_Tools](https://github.com/WareBare/WanezGD_Tools)) is MIT, but it
emits Grim Dawn's own `^`-letter colour codes into the game's text files; the
letter → RGB table lives in the engine binary, not in any shipped file. Checked
the install directly: `Text_*.arc` uses generic codes (`{^S}` on every damage
type alike, not one per type), and the only colour-named records in the `.arz`
are UI widget pulse animations. So the palette stays ours — chosen for contrast
on this ground, which is the part that matters and the part the game's own
palette does worst.


### Fifth pass (same session): HOLD, three marks, and the DoT twins

- **The tooltip was saying HOLD before any advice existed.** `buildTooltip`
  rendered a level gap as `needs level 84 (HOLD until then)` — the same phrasing
  the context document uses, which was the point, but the document is addressing
  the *advisor* in the middle of a candidate ranking and telling it not to reject
  an item over a deficit levelling will close. Addressed to the player, on 44
  items in `_Suchka`'s stash with no run in sight, it read as a recommendation
  the tool had not made. The UI line is now `needs level 84 — 2 more`: a gap and
  nothing else. The document's copy is unchanged, so its bytes are too. Same
  category error the plan schema now guards against, one layer up.
- **Three marks, not one.** `actionMarks` replaces `actionableIds` and returns
  the *kind*: `equip` (green — put this on now), `hold` (amber, the colour the
  "until level 84" threshold is already written in — keep it, you will put it on
  later) and `destroy` (red — an extraction spends this item). One green flag
  for all three turned a stash of things to wait for into a stash of upgrades.
  Priority when an id appears twice is destroy > equip > hold: the irreversible
  one wins. `keyMoves` item ids were dropped from the mark — a key move argues
  about items its verdicts already name, and a mark meaning "mentioned
  somewhere" is not an action. Container tabs carry one badge per kind.
- **Damage-over-time types get their own shade of their parent's colour.** The
  six twins are named `Burn`, `Frostburn`, `Electrocute`, `Poison`, `Vitality
  Decay` and `Internal Trauma` — verified against the game's own
  `tagCharStats*` strings, not assumed — and each is a separate stat that caps
  and resists on its own, so painting `+30% Burn Damage` in exactly the Fire
  colour hid a real distinction. Same hue, lighter and less saturated:
  recognisably the family, not the same stat. Bleeding is **not** one of these —
  it has no direct twin and never converts, so it keeps its own colour.
  Checked against every distinct stat line `_Suchka` can reach: 1131 lines, 132
  now DoT-classified, and no Acid line taken by the Poison pattern (`Poison` and
  `Acid` are separate damage types with a *shared* resistance, which is why
  `Acid Resistance` still reads as acid). `\bburn\b` cannot match inside
  `Frostburn` — no word boundary between `t` and `b` — which is the whole reason
  the pattern works, so there is a test pinning it.

320 tests (adding `test/stat-colors.test.ts`), 66 story assertions, context
document still byte-identical.

### Sixth pass (same session): hover state, and where the panel opens

- **The hover state was a property of the advice, not of the pointer.** A card
  lit up only when it had a *second* item to cross-highlight — an `EQUIP`
  naming a candidate, a `SWAP-COMPONENT` naming the host it destroys — so
  `RE-AUGMENT` rows and every worn item silently had none. That is two different
  ideas sharing one class. They are separated now: `:hover` means "you are
  pointing at this" and belongs to every card, worn or proposed, in the loadout
  and the materials list; `.highlighted` means "something *else* is pointing at
  this" and stays brighter, because it has to be findable in a grid of two
  hundred with the pointer nowhere near it.
- **The tooltip anchors to the slot row, not to the card under the pointer.**
  Making the whole card a hover target moved the position reference from a 46 px
  icon to a 300 px card, so `right-start` put the panel on top of the card in
  the next column — which in a loadout row is precisely the item being compared
  against. `anchorFor` walks up to `.slot-row`, so the panel clears both cards
  and lands in the same place whether the pointer is on the icon, the name, the
  component chip or the slot label. Stability matters as much as the clearance:
  a panel that moves as you read across a row has to be chased. Outside a slot
  row — grid cells, material rows — the element is already the right size and
  the pointer is already on the thing being described, so nothing changes.

71 story assertions.

### Seventh pass (same session): one highlight, where the panel opens, a legend

- **One highlight, whatever caused it.** The previous pass gave `:hover` a
  dimmer treatment than `.highlighted` on the theory that "you are pointing at
  this" and "something else is pointing at this" are different states. They are,
  but the difference is not worth a second brightness: what the advice says
  about an item is already carried by the row's border and by the corner flag in
  the containers, and a second, quieter highlight only made the reader ask which
  one they were looking at. Same colour for both now.
- **The panel opens below the card, left-aligned with it.** Anchoring to the row
  (the previous pass) was stable but wrong in the other direction: it put the
  panel past the proposal column even when the pointer was on the worn item at
  the far left, which is a long way from what is being described. Anchoring to
  the *card* with `bottom-start` keeps it next to its subject, clears the card
  it is being compared against — a loadout row is a comparison two cards wide,
  and any side placement lands on the other one — and still holds still while
  the pointer moves over the icon, the name and the component chip, because the
  anchor is the card and not the part under the pointer. What it covers is the
  rows underneath, which are not part of the comparison. `flip` puts it above
  when there is no room below.
- **The corner flags have a legend.** They and the tab counts are the only marks
  in the window that mean something without being hovered, so they are the only
  ones that need saying out loud. Drawn with the same triangle in the same three
  colours as the flags themselves — a legend that does not look like the thing
  it explains explains nothing — and it appears and disappears with the marks,
  so a window with no advice run has neither.

74 story assertions.

### Eighth pass (same session): one verdict column, cards aligned

The socket-move caption sat *above* the proposed card, which pushed it a line
lower than the worn one — and the row exists so the two can be read side by
side. Two fixes rather than the two the user proposed (a spacer on every row, or
dropping the extraction warning), because the row already had the right place
for both parts:

- **The verdict goes in the verdict column, for every verdict, abbreviated.** It
  was only there for the short ones; `SWAP-COMPONENT` spelled out needs 120 px,
  so socket moves put it over their card instead — and 120 px is width taken
  from the two things the row exists to compare. `shortVerdict` cuts the four
  socket verdicts to `+COMP` / `↔COMP` / `+AUG` / `↔AUG`, which keeps the one
  distinction inside each pair that matters: **`+` fills an empty socket and
  costs nothing; `↔` replaces what is in one**, destroying the old component or
  throwing the old augment away. That is the difference between a free upgrade
  and a decision, so it is the part that survives shortening. The column is
  68 px, sized to a measured 54 px worst case rather than a guess — a column
  that merely nearly fits clips the one verdict the reader most needs to read.
  The full word is on the tag's `title` and printed in full in the advice
  table's Action column, which is what makes abbreviating safe; `stories:check`
  asserts both, and that nothing is clipped.
- **"destroys X" goes with the other costs**, in the reason line under the cards
  where gains and costs already live. It is the price of the move — the Inventor
  recovers the component *or* the item — and a price is not a caption. It is in
  the proposal's tooltip as well, so nothing was lost by moving it.
- **The two cards align at the top, not on their centres.** Even with the
  caption gone, a name that wraps to two lines makes one card taller, and
  centring two boxes of different heights puts their first lines at different
  heights — an `EQUIP` row was 6 px out. `align-self: start` on the cards fixes
  every row; the label and the verdict stay centred, which is right for them.
  `stories:check` now asserts the offset is zero in *every* row that has both
  cards, not only the socket ones.

77 story assertions.

### Ninth pass (same session): the advice table's gains and costs

Same change the loadout already had, for the same reason. Gains and costs were a
fifth column, so a stack of one-per-line fragments squeezed into whatever width
four name columns left over set the height of every row by its longest stat
string. They now get a **full-width line under their row** — one `<tbody>` per
verdict, which keeps the pair one row-group and lets the hover and the click
cover both lines — where they read as a sentence while the columns above stay a
table. The `why` sentence joins them there rather than being dropped.

82 story assertions.

### Tenth pass (same session): the table fits, and the table explains itself

Asked whether the advice table could truncate at small widths and whether it
needed a horizontal scrollbar. It could — and the measurement found something
worse than the question assumed:

- **The table was already clipped at the app's own window size.** Auto layout
  gave each of four name columns up to its `max-width`, so the table came to
  735 px inside a 689 px panel, and the pane clips horizontally rather than
  scrolling — the Action column was being cut off with nothing to say so. Now
  `table-layout: fixed` with proportional columns (20/29/26/25), which fits at
  every width the layout has: 657 in 689 at 1920, and measured down to 900.
  A `.table-scroll` wrapper is kept as a last-resort scroller: it never triggers
  today, but the failure it guards is *silent*, which is the kind worth a
  belt-and-braces.
- **Nothing an ellipsis hides is unreachable.** The two item cells carry the
  item's own tooltip and the Action cell carries the socketable's — this table
  is where a reader decides whether to act, and deciding means reading the stats
  of both items and of the component being installed. The Action panel also
  carries the advisor's **reason** for the move: the stats say what the
  component does, the sentence says why it is the one being proposed. Cells with
  no tooltip to give keep a plain `title`.
- **The markdown tab was only passing because the fixture answer was tame.** A
  real answer is model output this window has no control over. `HOSTILE_ANSWER`
  and its story are the case that actually bites: a table with more columns than
  the panel is wide, a fenced block of long lines, an identifier with nothing in
  it a line may break at. Each has its own escape hatch — the table and the code
  block scroll inside themselves, `overflow-wrap: anywhere` handles the prose —
  and `stories:check` asserts none of them widens the panel.

93 story assertions.
