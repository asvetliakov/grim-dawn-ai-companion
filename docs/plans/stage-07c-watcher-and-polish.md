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

## Outcome

Done, with the plan wrong on two points and one of them load-bearing.

### The parsers do not throw on a torn write

The plan's retry design says "parse with up to 3 retries, 1 s apart — a checksum
failure is a torn write, not corruption". That is the right *policy* and the
wrong *mechanism*: **`parseGdc` does not fail on a torn file.** Stage 1's rule is
that an unknown block must be skipped rather than be fatal, so `parseBlock`
catches a bad decode, resynchronizes from the block's trailing checksum and
reports `checksumOk: false` — and hands back a perfectly ordinary
`CharacterSave` with half the equipment missing. A truncated file is quieter
still: the blocks that *are* there checksum fine and the walk simply stops, with
a warning about the bytes it could not use.

So a watcher that only caught exceptions would have announced every autosave as
an update, retried nothing, and never once reached the backup fallback. The check
is `parseProblem(parsed)` — any block that did not verify, or a warning matching
the truncation/overrun patterns. On a healthy save every block verifies,
*including* the 8 of 15 the parser skips as unknown, which is what makes this a
clean signal rather than a heuristic. The same check guards the `.gst` files,
which degrade identically.

Two consequences worth keeping:

- **The parsed save travels with the event** and is used through the new
  `SnapshotOptions.preparsed`. Letting main re-read the file would re-run the
  race the retries just won — and on the rotation-backup path it would lose it,
  since main would go back to reading the `player.gdc` that never settled.
- **The backup walk keeps going.** `player.g01` can be newer than `player.g00`
  and just as torn, so the fallback tries each in mtime order rather than
  trusting the newest.

### No chokidar

Dropped for the zero-dependency rule, like `sharp` (Stage 4), `execa` (Stage 6),
`react-markdown` (7A) and `lucide-react` (7B). `fs.watch(dir, { recursive: true })`
is FSEvents on macOS and ReadDirectoryChangesW on Windows — the two platforms
this runs on — and what chokidar adds on top of it (globbing, stat polling,
atomic-write heuristics) is either unnecessary or is the debounce-and-parse loop
above, which has to exist either way because a `.gdc` is only valid when its
checksums say so. The filesystem half is injected (`WatchBackend`), so the tests
fire events by hand; the timers are injected too, and the retry test uses the
injected `delay` as the hook it *repairs the file through*, which is exactly the
sequence the game produces.

### Deliverables as built

1. **`src/core/watcher.ts`** + CLI `watch`, plus a CLI **`paths`** command the
   plan did not ask for — the app check needed the detected save directory, and
   "where does this thing think my game is" turned out to be worth a command.
2. **Main wiring** in `SessionState`: `startWatching()` (explicit, because
   `fs.watch` on a missing directory throws and a wrong save path should open a
   window that says so), restart on a `saveDir` change, and a new `save-problem`
   push for the case where nothing readable was found. That last one is an
   **amber banner, not the error one**: the last good snapshot is still on screen
   and still true, it is simply not the newest.
3. **Settings pane**, which absorbed the old read-only `Paths` popover — it
   showed the two directories and gave no way to change either. Paths are typed
   *or* picked from what detection found, committed on blur rather than per
   keystroke (`gameDir` and `locale` each drop the item database). Backend and
   model are **dependent selects**: a model name typed for the wrong backend
   fails eight minutes into a run instead of at the moment it was typed.
4. **Polish**: always-on-top (a *choice*, so `settings.json`) and window geometry
   (*state*, so a sibling `window.json`), with `restoreBounds` clamping the size
   and re-centring a window whose monitor has gone. A real application menu, ⌘,
   and ⌘D. The context viewer opens **rendered** with a **Raw** tab — the exact
   bytes are the id-stability contract, but thirty thousand tokens of resistance
   tables are a wall of pipes as plain text.

### Asked for mid-stage, and in

- **Portability and GOG.** `src/core/platform.ts` composes the search from three
  roots instead of spelling out paths, so Steam and GOG, CrossOver and Whisky and
  Wine and Proton and real Windows drive letters, and OneDrive's redirected
  `Documents`, all fall out of the same three lookups. Steam libraries on other
  drives come from `libraryfolders.vdf`.
- **The name.** *Grim Dawn AI Companion* in the window, the menu bar and the
  About box; `gd-ai-companion` on disk (the old directory is deliberately not
  migrated — it is a preference worth setting again in a pane that now exists,
  and a cache that rebuilds in half a minute). The macOS menu bar needed
  `app.setName` before `ready` **and `role: 'appMenu'` on the first menu**:
  without the role Electron does not recognise it, prepends a default app menu
  and demotes ours to a `File` menu with Settings hidden inside it.
- **Packaging.** `npm run dist` (macOS arm64 dmg + zip) and `npm run dist:win`
  (portable Windows x64 zip, cross-built from macOS — both verified). Windows is
  a zip rather than an NSIS installer because the installer needs Wine to build
  here; the cross-build works at all because there are no native modules to
  compile, which is the zero-dependency rule paying off a third time.

### Acceptance

| # | Criterion | Where it is proved |
|---|---|---|
| 1 | A save written while the app is open reaches the UI | `app:check` — a character *appears* in the picker; `cli -- watch` live |
| 2 | Torn write: retries, then the rotation backup, then says so | `test/watcher.test.ts` (injected clock); `app:check` tears a real save |
| 3 | Settings persist; locale/gameDir rebuild; saveDir restarts the watcher | `app:check` reads back `settings.json`; `test/watcher.test.ts` moves `saveDir` and proves the old watch stops |
| 4 | The difficulty override changes the document | `app:check` — 196,213 → 194,313 chars, subtitle names the difficulty |
| 5 | Always-on-top and geometry survive a restart | `app:check` relaunches the app and compares bounds |
| 6 | Tests, typecheck, core imports no Electron | 399 tests, typecheck clean, `src/core` still Electron-free |

399 tests (+20), 252 story assertions (+20), 41 app assertions (+17).
