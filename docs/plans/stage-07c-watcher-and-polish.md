# Stage 7C — Save watcher, settings pane & polish

## Goal

Close the loop on the app: live refresh when the game writes the save (replacing 7A's focus/manual refresh), a real settings pane, and the window-behavior polish that makes the tool pleasant to leave open beside the game.

## Context

7A ships refresh-on-focus + a Refresh button; that covers the "alt-tab to the companion" workflow but not "leave it on the second monitor". The game writes saves **event-driven and non-atomically** (on exit-to-menu, on certain events): a read racing the write sees a torn file, which the block checksums catch immediately — that's the retry design from Stage 1, now applied on a timer instead of a keypress.

This plan carries the watcher design from the original stage-07 sketch (now superseded by 7A/7B/7C).

## Deliverables

### 1. Watcher — `src/core/watcher.ts` (+ CLI `watch`)

New dep: `chokidar@^4` (pure JS in v4 — the no-native-modules rule holds).

- chokidar on the save dir (`<saveDir>/main/**/player.gdc` + the account `.gst` files); **2 s debounce** per path (the game writes several files in a burst).
- On change: parse with up to **3 retries, 1 s apart** — a checksum failure is a torn write, not corruption. If all fail, fall back to the newest `player.g00`-style rotation backup for that character. Emit typed events: `character-updated(name)`, `stash-updated`, `materials-updated`, plus `parse-failed(name, error)` after the fallback also fails.
- Timers injectable (constructor takes a `delay(ms)` / clock seam) so the retry path is unit-testable without real sleeps.
- CLI `watch` command that prints events — the watcher is verifiable without Electron, per the house rule that core is CLI-exercisable.

### 2. Main-process wiring

`src/main/state.ts` starts the watcher once a valid `saveDir` is known; events → rebuild the snapshot (save parse + resolve only; DB untouched) → push `snapshot-invalidated`; renderer's `SessionProvider` re-fetches. Watcher restarts on `saveDir` change. The 7A focus-refresh stays as a belt-and-braces fallback.

### 3. Settings pane (renderer)

A modal/pane off the 7A gear button, editing the real `Settings` schema (`src/core/settings.ts`):

- `saveDir` with an auto-detect button (`findSaveDir()`), `gameDir` (blank = auto-detect; changing it drops and rebuilds DB + icons with visible progress),
- `locale` (the 13 shipped languages; changing rebuilds the DB cache for that language),
- `provider` / `model` / `effort` / `advisorTimeoutSeconds`,
- `difficultyOverride` (same control as the header dropdown, one source of truth).

Every change goes through `updateSettings` IPC → `saveSettings` → the state-invalidation rules from 7A.

### 4. Polish

- Always-on-top toggle (menu item or header pin icon).
- Window size/position persisted (in settings.json or a sibling `window.json`) and restored.
- Advise error surfaces reviewed end-to-end: claude CLI missing (`available()` message), no characters found, missing game dir — each renders as a readable panel message, never a blank pane or a dead button.
- A "view context document" debug affordance (menu item: open the current `doc.markdown` in a scrollable view) — makes "what did the AI actually see" answerable in one click, which the difficulty dropdown acceptance below relies on.

## Acceptance criteria

1. With the app open, `touch`ing or re-copying `player.gdc` updates the UI within ~5 s; the same works for `transfer.gst` (stash tab re-renders).
2. Torn-write path unit-tested at the watcher level with injected timers: a parse that fails checksums twice then succeeds emits one `character-updated`; a parse that keeps failing falls back to the rotation backup; the CLI `watch` command demonstrates events live.
3. Settings pane edits persist across restarts; changing `locale` or `gameDir` rebuilds the DB with visible progress; changing `saveDir` restarts the watcher.
4. Difficulty override changes what the context document contains (verified via the view-context affordance).
5. Always-on-top and window geometry survive a restart.
6. `npm test` + `npm run typecheck` green; core still imports no Electron.

## Verification

```bash
npm test && npm run typecheck
npm run cli -- watch    # touch a save in another terminal → events print
npm run dev             # manual pass over criteria 1, 3–5
```
