# Stage 7 — Electron UI + save watcher

## Goal

The user-facing app: a small always-available window showing the selected character's equipped gear (with icons) and notable candidates, an **Advise** button that runs the Stage 6 pipeline and renders the recommendations, a difficulty picker, a settings pane — refreshing live when the game writes the save.

## Context

Everything below the UI already works from the CLI (Stages 1–6, all in Electron-free `src/core/`). This stage adds the Electron shell as a thin consumer. The game runs under CrossOver; this app runs natively and just reads files, so no game-process integration is involved.

## Stack & structure

Add: `electron@^38`, `electron-vite@^4`, `react@^19`, `react-dom`, `chokidar@^4`. Dev command: `npm run dev` (electron-vite). No packaging/electron-builder in this stage — dev mode is the ship vehicle for now.

```
electron.vite.config.ts
src/main/index.ts       # app lifecycle, BrowserWindow (~420×720, resizable, optional always-on-top toggle)
src/main/ipc.ts         # typed IPC handlers
src/main/protocol.ts    # gdicon:// scheme
src/core/watcher.ts     # chokidar wrapper (core, CLI-testable via `watch` command)
src/preload/index.ts    # contextBridge: exposes the typed API only (contextIsolation on, nodeIntegration off)
src/renderer/index.html
src/renderer/src/{App,CharacterPicker,EquipGrid,CandidateList,AdvicePanel,SettingsPane}.tsx
```

### IPC surface (typed, defined once in a shared `src/shared/ipc-types.ts`)

- `getState(): { characters: string[]; active: string; resolved: ResolvedCharacterSummary; settings }`
- `setActiveCharacter(name)`, `updateSettings(partial)`
- `advise({ question?, difficulty? }): AdvisorResult` (long-running — renderer shows progress, supports cancel via AbortController-backed IPC)
- push event `state-updated` (from watcher)
- Icons: **`gdicon://<encoded iconPath>`** custom protocol registered in main → returns the PNG from Stage 4's `getIconPng` (sharp stays in main; renderer just uses `<img src="gdicon://...">`).

### Watcher (`src/core/watcher.ts`)

chokidar on the save dir; 2s debounce; on change: parse with up to 3 retries 1s apart (checksum failure = torn write, not corruption); if all fail, fall back to newest `player.g00`-style rotation backup; emit typed `character-updated` / `stash-updated`. Also add CLI `watch` command that prints events (lets this be verified without Electron).

### UI (single window, keep it simple)

- Header: character picker (folders under `save/main/`), level/class/difficulty badge, difficulty override dropdown (Normal/Elite/Ultimate/auto), settings gear.
- Equip grid: the 12 slots + weapon swap, icon + name + rarity color; tooltip with stat lines; empty sockets/augments visually flagged.
- Candidates: top filtered candidates per slot (reuse Stage 5 filters), tagged inv/stash/transfer.
- Advise: button → spinner → markdown-rendered advice panel (verdict table, HOLD, SELL); "copy" button; optional question input field.
- Settings pane: save dir (with auto-detect button), provider, model, locale.
- Footer credit: "Item data & icons courtesy of GrimTools (grimtools.com) — data © Crate Entertainment".

## Acceptance criteria

1. `npm run dev` opens the window; `_Suchka` renders with correct icons in the equip grid (compare against the in-game character screen).
2. Live refresh: with the game running (or by `touch`/re-copying `player.gdc`), the UI updates within ~5s of the file write; torn-write retry path unit-tested at the watcher level (`watch` CLI command demonstrates events).
3. Advise button returns rendered recommendations in-window; cancel works; errors (e.g. claude missing) surface as a readable message, not a blank panel.
4. Difficulty dropdown changes the context doc sent (visible in a debug "view context" affordance or log).
5. Settings persist across restarts; character switch re-renders fully.
6. `npm test` + `npm run typecheck` green; renderer imports nothing from `sharp`/`fs` (enforced by the preload boundary — contextIsolation on).

## Verification

```bash
npm test && npm run typecheck
npm run cli -- watch   # then touch the save file in another terminal → event printed
npm run dev            # manual pass over criteria 1-5; screenshot the window for the record
```
