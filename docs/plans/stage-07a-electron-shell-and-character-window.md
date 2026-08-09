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
