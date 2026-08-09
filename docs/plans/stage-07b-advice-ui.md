# Stage 7B — AI advice integration: envelope, side panel, item highlighting

## Goal

Wire Stage 6's advise pipeline into the 7A window: an Advise button with a question input, honest progress and cancel over the ~500-second run, a collapsible **right side panel** showing the structured answer (summary, key moves, the verdict table) with the full markdown answer on demand — and the advice painted onto the gear itself: actionable items get a badge + colored border on the doll and in the grids, tabs holding non-visible actionable items get a highlight dot, and hovering a marked item shows the action tooltip beside the base tooltip.

## Context

7A shipped the shell, the character window, the grids and tooltips, and **defined** the full IPC contract including the advise channels — this stage implements them. The advise pipeline itself (provider, repair loop, verification) is done and battle-tested from the CLI; what's new here is a typed envelope in core, per-character persistence, the main-process run manager, and the renderer's advice views.

Facts this stage builds on (all verified in code):

- `AdvisorProvider.advise(req, signal?: AbortSignal)` — cancellation already works end to end (`claude-cli` kills the child by process group). No streaming; the only mid-run hook is `onRepair(warnings)` firing before the single corrective call. Orchestration entry: `adviseWithRepair(provider, req, check, opts)` → `RepairOutcome { result, warnings, firstWarnings, revised, revisionRejected, results[] }` (`src/core/ai/repair.ts`).
- A real run is **~500 s and ~$4** (measured; the 900 s timeout is a runaway ceiling, not an expectation). Iterate against the `mock` provider (`MOCK_ID`, `CANNED_ANSWER`); do one real run for the record.
- `AdvisorPlan` (`advisorPlanSchema`, `src/core/ai/provider.ts:204`): `summary?`, `verdicts[]` (`slot`, `itemId`, `itemName?`, `verdict`, `target?`, `targetId?`, `targetName?`, `enablers?`, `componentFrom?`, `gains?[]`, `costs?[]`, `reason`), `keyMoves[]` (`title`, `slots[]`, `itemIds[]`, `detail`), `hold[]` (`itemId`, `reason`, `until?`, `needs?`), `sell[]` (bare ids), `projectedResistances?`, `projected?`, `nextLevels?`.
- The verdict enum is exactly 7 values: `KEEP | EQUIP | RE-AUGMENT | ADD-COMPONENT | SWAP-COMPONENT | BUY-AUGMENT | CRAFT`. `hold` and `sell` are **not** verdicts — separate arrays, no slot. `SOCKET_VERDICTS`' targets name a socketable; `isReplacement` is true only for `EQUIP`.
- **Badges must read `plan.verdicts[].verdict` (the raw enum), never `verdictRows[].action`** — the latter is a freeform display string (`''`, `'KEEP'`, `"RE-AUGMENT Kymon's Might"`).
- **Slot binding is by item id, never by the `slot` string** — `verdicts[].slot` is model-authored freeform text; the reliable join is `itemId` → `ContextDoc.itemsById` → the item's position.
- Doc ids are 4–5 chars (letter-suffixed on hash collision in document walk order) and **only reproducible from identical save + DB state**. Socketables (components/augments) share the same id namespace via `shortHash(record)`.
- `checkPlan` (`src/core/ai/verify.ts`) takes `{ itemsById, socketables, socketablesById }` and returns `PlanWarning { kind, message }[]` (7 kinds); the CLI feeds them back for exactly one repair call and keeps whichever answer is cleaner.
- The CLI's `--json` envelope is an **inline object literal** at `src/cli/index.ts:~1276` with no exported type — that's the first thing this stage fixes.

## Core adjustments

### 1. Typed envelope — `src/core/ai/envelope.ts`

```ts
export const adviseEnvelopeSchema = z.object({
  character: z.string(), generatedAt: z.string(), gameVersion: z.string(),
  provider: z.string(), model: z.string().nullable(), effort: z.string().nullable(),
  question: z.string().optional(),          // NEW — what the user asked, if anything
  calls: z.number(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number() }),
  durationMs: z.number(),
  warnings: planWarningSchema.array(), firstWarnings: planWarningSchema.array(),
  revised: z.boolean(), revisionRejected: z.boolean(),
  answer: z.string(),                        // the full markdown answer
  plan: advisorPlanSchema.nullable(),
  verdictRows: verdictRowSchema.array(),
  itemNames: z.record(z.string(), z.string()),
  socketableNames: z.record(z.string(), z.string()),
});
export type AdviseEnvelope = z.infer<typeof adviseEnvelopeSchema>;
export function buildEnvelope(args: {...}): AdviseEnvelope;
```

Field-for-field the CLI's current literal plus `question` — replace the literal with `buildEnvelope` so `advise --json` output is identical (existing consumers unaffected) and the shape finally has one owner. `PlanWarning` and `VerdictRow` need small zod schemas to compose (`verdictRowSchema` mirrors the existing `VerdictRow` interface).

### 2. Advice persistence — same file

```ts
export function lastAdvicePath(character: string): string;              // appDataDir()/advice/<character>.json
export function saveLastAdvice(env: AdviseEnvelope): void;
export function loadLastAdvice(character: string): AdviseEnvelope | undefined;  // safeParse; drift → undefined
```

Last run only, one file per character dir name (already filesystem-safe). Schema drift degrades to `undefined`, never throws — an old advice file must not break app start.

### 3. What the envelope does *not* carry — by design

No per-id location, coordinates, or icon paths. The UI joins `plan.verdicts[].itemId` (and `hold[].itemId`, `sell[]`, `targetId`) against the **live snapshot's** doc ids. Ids are only reproducible from identical save+DB state — so when the save has changed since the advice ran, stale ids simply fail to join and are listed under the verdict table by name (from `envelope.itemNames`) as "no longer present (item moved or changed)", never silently dropped. Persisting coordinates would be exactly as stale, with false confidence.

## Main process — `src/main/advise.ts`

One run at a time: `activeRun: { runId, character, controller: AbortController, startedAt, phase } | null`; a second `startAdvise` while one is live rejects with a readable message. The run lives entirely in main, so it survives renderer reloads and busy frames; `getAdviseStatus()` lets a freshly-mounted renderer re-attach.

Flow per run, mirroring the CLI's `advise` action:

1. `createProvider(settings.provider, { model, effort, timeoutMs })` → `available()` gate (claude CLI missing → `advise-error` with the provider's own message).
2. Build the context from the **current snapshot** (`CharacterSnapshot.doc` — 7A's `loadSnapshot`); push phase `context`.
3. `adviseWithRepair(provider, { contextDoc, question }, check, { signal: controller.signal, onRepair })` with the same check input as the CLI: `itemsById`, `socketables`, `socketablesById` from the doc. Phase `asking`; `onRepair` fires → phase `repair`.
4. Completion: `buildEnvelope` (with `question`), `saveLastAdvice`, **then** push `advise-done` with the envelope. Abort/error → `advise-error`.

Progress is **honest phases + elapsed time only** — a ~500 s opaque subprocess gets no fake percentages. The renderer runs its own elapsed timer off `startedAt`.

Model/effort discipline: the provider factory already pins `--model opus --effort high` defaults from settings — do not let the UI silently inherit anything else (two runs on the same save must stay comparable).

## Renderer

> **Amended after 7A's third review pass — some of this already exists.** 7A
> built, against the fixture envelope:
>
> - **The markdown renderer.** `src/renderer/src/markdown.ts` (tokenizer) +
>   `components/Markdown.tsx` (painter), hand-written, ~7 unit tests. **Drop the
>   planned `react-markdown` + `remark-gfm` dependency**: the repo takes no
>   runtime deps, and the property that motivated choosing react-markdown over
>   marked — no raw-HTML pass-through — is stronger here, because the parser
>   emits a tree whose every leaf is text. There is no code path to `innerHTML`
>   at all. It already handles GFM tables, both list kinds, blockquotes, fences,
>   rules and inline emphasis/code/links.
> - **The "Full answer" view**, as a tab beside the plan in `AdvicePanel`.
> - **The standing actionable mark** — `actionableIds()` in `advice.ts` folded
>   into `HighlightProvider` as a second, non-hover set; painted as a corner flag
>   on `.item-cell`/`.material-row`, with a per-tab count. This is a coarser
>   thing than `adviceMarks` below (a boolean, not a typed badge); 7B should
>   *refine* it into the typed badges rather than add a third mark.
> - **Socket verdicts in the loadout**: `SocketableFace` renders the proposed
>   component/augment with its own stats, the verdict, and what an extraction
>   destroys, resolved through `UiSnapshot.socketables` (dossier id →
>   `UiSocketable`). The `AdviceMark.targetId`-is-a-socketable case below is
>   therefore already answered for the loadout column; what is left for 7B is the
>   badge on the host item in the grids.
>
> Still to add here: `lucide-react` for the badge icons, and the run plumbing —
> streaming the answer as it arrives and animating the tab while a run is in
> flight, both of which need the live advise calls 7A stubs.

`AdviceProvider` context: `{ envelope, run: { runId, phase, elapsedMs } | null, start(question), cancel() }`; on mount calls `getAdviseStatus()` + `getLastAdvice(activeCharacter)` — an app restart re-shows the last advice.

### Advice side panel (collapsible, right side)

- Idle: question input + **Advise** button (+ a note that a run takes ~8 minutes).
- Running: phase label (`building context` → `asking` → `revising`), elapsed clock, **Cancel**.
- Done: `plan.summary` up top; key moves as cards (`title` + `detail`, items linked — hover highlights them in the grids); the **verdict table** from `envelope.verdictRows` (the same rows the CLI renders: Slot | Current | New | Action | Gains/costs | Why, `KEEP_CELL` for keeps); the stale-id note when ids failed to join; warnings if any survived; the cost line (`calls`, `usage.costUsd`, duration). "Full answer" opens the markdown view (own tab or expanded panel) rendering `envelope.answer`.
- Errors render as readable text in the panel, never a blank pane.

### Advice marks — `src/shared/advice-marks.ts` (pure, unit-tested)

```ts
export interface AdviceMark {
  kind: 'verdict' | 'hold' | 'sell';
  verdict?: Verdict;            // absent for hold/sell
  targetId?: string;            // marks the incoming item/socketable too
  gains: string[]; costs: string[]; reason: string;
  keyMoves: string[];           // titles of key moves referencing this item
}
export function adviceMarks(plan: AdvisorPlan): Map<string /* docId */, AdviceMark[]>;
```

- `KEEP` gets **no** badge (it's the default state, not an action).
- An `EQUIP` marks both sides: the equipped item's slot *and* the incoming candidate (`targetId`) wherever it sits — that's what makes "go fetch it from the stash" visible.
- `hold[]` and `sell[]` mark by bare id.
- Socket verdicts' `targetId` may be a socketable id (no position) — the mark then lives only on the host item.

### Painting the marks

- Badge + border on the item cell (doll and grids). Mapping lives in one place, `src/renderer/src/badges.ts`:
  `EQUIP` → ArrowUpCircle, green · `RE-AUGMENT`/`BUY-AUGMENT` → Sparkles, blue · `ADD-COMPONENT` → PlusCircle, blue · `SWAP-COMPONENT` → RefreshCw, blue · `CRAFT` → Hammer, amber · hold → Clock, grey · sell → Coins, red.
- Tab/bag highlight: a `useMemo` folds snapshot containers × marks into `{ inventory: boolean, bags: boolean[], stash: boolean[], transfer: boolean[] }`; any tab or bag whose marked items are not currently visible gets a highlight dot — the user must never miss an action because it's on another tab.
- Hover on a marked item: the base `ItemTooltip` **plus** an `ActionTooltip` beside it — badge, one action sentence (verb + target name, e.g. "Swap component → Seal of Blades", built from the verdict + `targetName`), gains/costs lists, reason. Both tooltips render in the same floating-ui layer.

## Acceptance criteria

1. `advise --json` output validates against `adviseEnvelopeSchema`; the CLI uses `buildEnvelope`; the emitted fields are identical to before plus `question`.
2. The Advise button starts a run; phases and elapsed time show; Cancel aborts it (verified against the `mock` provider for iteration and one real run for the record); reloading the renderer mid-run re-attaches via `getAdviseStatus` and still receives the result.
3. On completion: summary, key moves and the verdict table render in the side panel; the full markdown answer renders in its own view (GFM tables work; raw HTML in model output does **not** render as HTML).
4. Actionable items show badges + colored borders on the doll and in the grids (badge chosen from the raw verdict enum); `targetId` items are highlighted too; tabs/bags containing non-visible marked items show a highlight dot; hovering a marked item shows the base tooltip plus the action tooltip.
5. Advice persists to `advice/<character>.json`; an app restart re-shows it for the active character; ids no longer present in the current save are listed as stale by name, not silently dropped.
6. `npm test` + `npm run typecheck` green. New unit tests: envelope schema round-trip on a real `--json` file; `saveLastAdvice`/`loadLastAdvice` in a tmp dir incl. drift-rejection; `adviceMarks` — verdict/hold/sell marks, `targetId` double-marking, socketable-target-without-position, stale-id behavior.

## Verification

```bash
npm test && npm run typecheck
npm run cli -- advise --char _Suchka --json out.json   # then: envelope validates, UI can load it
npm run dev   # mock-provider run for flow; one real run for the record; screenshot panel + marked grid
```

## Outcome

All five deliverables landed, and the run manager turned out to be the testable
part rather than the untestable one. Verification: **346 tests**, **150 story
assertions** (up from 100), and **12 assertions driven through the real Electron
window** — the half no story can reach.

### What the plan got right and what it cost

- **The envelope moved to `buildEnvelope` and the CLI's `--json` is byte-identical.**
  Proven rather than asserted: the same `advise --provider mock --json` run
  before and after the change, diffed with `generatedAt`/`durationMs` masked —
  same eighteen keys in the same order, same values. `question` is **omitted**
  when there is none rather than written empty, which is what keeps that true for
  a run with no question.
- **`PlanWarning` and `VerdictRow` became zod schemas** (in `provider.ts`, where
  they already lived) so `adviseEnvelopeSchema` could compose them. Their
  exported *types* are now inferred from the schemas, so there is still one
  definition of each and no drift to police.

### Two deviations from the plan, both forced

- **Persistence is `src/core/ai/advice-store.ts`, not "the same file".** The plan
  put `saveLastAdvice`/`loadLastAdvice` in `envelope.ts` — but that module is in
  the *renderer's* type graph via `src/shared/ipc.ts`, which compiles with
  `types: []`. A `node:fs` import there is a compile error, which is exactly the
  mechanical guarantee the repo wants; the split is what preserves it rather than
  a taste call. Same reasoning made `buildEnvelope` take an `AdviseRun` described
  structurally instead of importing `RepairOutcome`, which would have dragged
  `verify.ts` → the resolver → the database types across that boundary for the
  sake of six field names.
- **No `lucide-react`.** Nine glyphs at 12 px are nine `<path>`s, and the repo
  takes no runtime dependencies — Stage 7A declined `react-markdown` on the same
  grounds and was right to. `badges.tsx` draws them in one 16×16 box so they
  match optically at the size a 32 px cell allows. The plan's **blue for socket
  moves** went with it, and for a sharper reason than bundle size: a socket
  verdict's subject is the item you are *wearing*, and worn items are not in a
  container, so the colour would have had nothing to colour. The four colours
  that survive are the four things that can happen to something in a container.

### What the review passes changed

- **`ActionKind` gained a fourth member, `sell`.** 7A's three colours covered
  equip / hold / destroy; `plan.sell` had nowhere to go and was silently unmarked.
  Red for both destroy and sell would have merged two different instructions —
  an extraction *spends* the host to recover what is in it, a sell is a judgement
  that the item is not for this build — so sell is the dim end of the same warm
  range, because it is never urgent.
- **The corner flag grew a glyph.** Four colours in a stash of two hundred items
  is where a mark stops explaining itself; an arrow pointing up out of the cell
  does not need the legend, and a clock is a clock. The legend keeps its swatch,
  now drawn as the same badge, because each *kind* has exactly one glyph — which
  is only true because everything a container holds is put on, kept, spent or
  sold.
- **`actionMarks` is derived from `adviceMarks`** rather than reading the envelope
  a second time. The badge, the colour, the tab counts and the action tooltip are
  four views of one reading of the plan.
- **The fixture's EQUIP verdicts carried no `gains`, `costs` or `reason`** — only
  their rendered rows did. A story caught it: the action tooltip reads the *plan*,
  so it had nothing to say about the two most important moves in the fixture.
  `verdictRows` is derived *from* those fields, so a fixture that filled only the
  rows was describing an envelope no run can produce.

### The tooltip, which took four passes of its own

The advice panel beside the item panel turned the floating layer from one child
into two, and every consequence of that was a bug worth fixing:

- **The wheel died over the panel.** It takes pointer events (7A's decision, and
  right) and is portaled to the body, so a wheel there reached neither the panel
  — nothing to scroll — nor the pane it was covering, which is not an ancestor.
  Now a panel taller than the viewport scrolls itself (`max-height: calc(100vh -
  24px)`), and one with nothing left to scroll forwards the delta to the pane the
  *card* lives in. A native listener, because React registers `wheel` passively
  at the root and `preventDefault` there is ignored — and attached from the **ref
  callback**, because `FloatingPortal` mounts its child in an effect of its own,
  so an effect here finds `refs.floating.current` still null and, with nothing
  left to change, never retries.
- **`scrollTop += deltaY` is correct and feels wrong.** A mouse notch is one
  ~100 px event that Chromium *animates* over about a tenth of a second; applied
  directly it landed in a single frame and read as clunky beside the container
  next to it. So a notch eases out over frames (22% of the remainder each) and a
  **trackpad gesture is passed straight through** — easing that would put the
  scroll four frames behind the fingers, which is the lag this exists to remove.
  The 40 px threshold is what tells them apart.
- **The empty space beside the shorter panel was an invisible hover target.** Two
  panels of different heights make the flex row's own box as tall as the taller
  one, and the row took pointer events — so the pointer could sit in open ground
  below the advice block with the tooltip refusing to close. The layer now takes
  **no** pointer events and each panel takes its own, which makes the hover region
  exactly what a reader can see. `gap: 0` for the mirror-image reason: a gap
  between them belongs to neither panel, and crossing it would hand the pointer
  to whatever item cell is underneath.
- **A 200 ms delay before a panel appears, and 220 ms before it goes.** The first
  draft delayed only the *cold* open and switched instantly afterwards, on the
  theory that a reader comparing items has already asked to see them. Reverted on
  review: it made the two cases feel like different controls, and the strobe came
  straight back the moment a panel was up — brushing a component chip on the way
  to the panel flashed the component and flashed back. One rule now, and the
  anchor moves **with** the subject rather than with the pointer, or the panel
  would slide to the new card while still describing the old one.
- **The highlight follows the panel, not the pointer.** Moving onto the panel to
  finish reading it emptied the pointer set, so the card and its container copy
  went dark mid-sentence. A second *held* set, unioned with the pointer's and
  owned by the tooltip — everything else that highlights (a verdict row naming
  two items, a key move naming four) really is transient. That exposed two gaps:
  the loadout's **worn** card had never been wired for the highlight class at all
  (it relied on `:hover`), and a socket-move row lit **both** its cards, because
  the proposal *is* the same item and carries the same document id. The row now
  remembers which side was pointed at, and only where the two ids collide —
  filtering by side on an EQUIP would stop a verdict row from lighting the worn
  item just because the proposal was pointed at last.

### The run manager

`src/main/advise.ts` imports nothing from Electron, which turned the hardest part
of this stage into ordinary unit tests: phases in order, the revising phase when
a plan fails a check, a second `start` refused, cancel-by-id (and a stale id
**not** killing the live run), a dead backend surfacing in its own words, and a
failure kept until someone asks so a reload does not lose it. The provider is
injected the same way `claude-cli` injects its `spawn` — cancellation and
survival-across-a-reload are *timing*, and neither can be tested against a real
eight-minute subprocess. The character is the live save, because `planCheckInput`
verifies a plan against what the document actually offered and a stubbed dossier
would test a document nothing produces.

`SessionState` keeps the `CharacterSnapshot` the UI snapshot was built from, so a
run uses **the document the window is showing** rather than one compiled a moment
later from a save the game may have rewritten in between. That identity is the
whole basis of the advice-to-item join.

### Driving the real window

Playwright's `_electron` runs the built app, which covers what no story can: the
preload bridge, the nine IPC channels, the run manager and the file. Click Advise
→ phases → verdict table → cost line → `advice/_Suchka.json` on disk → reload →
the advice comes back. One trap worth recording: **this environment exports
`ELECTRON_RUN_AS_NODE=1`**, which turns the Electron binary into plain Node, so
`require('electron').protocol` is undefined and the main process dies on line
one. `env -u ELECTRON_RUN_AS_NODE` is the fix. A second, funnier one: "the
proposal column is locked before any run" fails on the *second* invocation — by
working, because an app restart is supposed to re-show the stored advice.

### The live run, for the record

One real `claude-cli` run, started from the window's own Advise button and driven
by `scripts/check-app.mjs` against the real settings directory:

**2 calls · opus, effort high · 210,627 in · 64,878 out · $3.78 · 12m 03s.**
`asking the model` at 0 s, `revising the plan` at **598 s**, answer at 723 s —
so the repair loop fired live and the phase labels are only observable on a run
that takes real time, which is why the sequence itself is pinned in
`test/advise-runner.test.ts`. **2 `ambiguous-stat` warnings on the first call →
one revision → clean**, which is the branch Stage 6B built and the one worth
seeing end to end in the UI.

The answer: 14 verdicts (**9 BUY-AUGMENT**, 2 RE-AUGMENT, 1 EQUIP, 2 KEEP), 3
holds, **13 sells**, 5 key moves, 28 k of prose, `itemName` on 14/14 and
`targetId` on 12/14. Sixteen items marked on the live grid, and the legend read
*equip now 1 · keep for later 3 · sell or salvage 13* — so the fourth
`ActionKind` earned itself on the first real plan rather than on a hypothetical:
without it, thirteen items the plan says to get rid of would have carried no mark
at all.

What it argued, which is the thing the window exists to show: *nine augment slots
are empty and the three that are filled all carry Wight Skin Powder, pouring 45
points into an Aether resistance already 74 over cap.* The nine BUY-AUGMENT rows
render as the same item with the new augment in it and only the augment chip
marked, and the sheet's projection column carries the consequence — Pierce 87 →
129, Fire 74 → 122, Lightning 74 → 122, Bleeding 38 → 78, **Aether 154 → 109**,
which is the over-cap resistance being spent rather than lost.

One cosmetic note on the record: the cost line reads `asked: "mock run —
verifying the pipeline"` because the driver script's question string was reused
for the live run. The question plumbing is what was being checked, and it round-
tripped through the envelope and the file; the text is the harness's, not a real
question.

### Review pass after the live run

Ten pieces of feedback, and the interesting thing about them is where they came
from: **four were the live run telling us what the plan had no way to say.**

- **`fits` on a verdict.** One verdict per slot has one name, and an item holds a
  component *and* an augment in independent sockets — so a slot that needs two
  socketable changes had nowhere to put the second. The Neck `EQUIP` argued in
  prose for fitting Maiven's Lens with a loose Dread Skull *and* a Sagethorn
  Powder and the plan carried neither; `projected.notes` contained the sentence
  *"two free component fills are part of this plan and are not separate verdict
  rows"*, which is a model working around a schema. `target`/`targetId` stay the
  socketable the verdict is *named* for and `fits` is everything else. A fit is
  checked against the item the slot **ends up** holding — the candidate for an
  `EQUIP` — because checking the outgoing item would clear a component for gear
  the plan is telling you to take off. It also earns two checks of its own: two
  fits of one kind is not a legal item state, and a right id with a wrong name is
  the failure an id-only plan hides.
- **`nextLevels` was in the schema and rendered nowhere.** Two of the four entries
  on the live run were *"skip this"* — a recommendation that exists only there,
  since §12 costs every threshold and a costing with no verdict on it is not
  advice.
- **The plan block was printed twice**, once as the Plan tab and once as 17k of
  raw JSON at the end of the Full answer's 28k. `answerProse` strips it by
  *parsing* the trailing block rather than trusting its info string: `parseAdvice`
  accepts a bare fence, so going by the tag alone eats any code block an answer
  happens to end on — which is exactly what the hostile-answer story caught.
- **Thirteen sells with no visible mark.** `sell` was `--ink-faint`, which on this
  ground is the one colour a reader scanning a stash will not find. The mark is
  now a **flat ring plus a tint plus a glyph**, since a corner flag is 11 px in a
  32 px cell in a grid of two hundred; **sell is red** and **destroy is violet**,
  deliberately off the traffic light because spending a host in an extraction is
  not a point on a scale of urgency. The ring's first draft had an inset glow and
  every marked cell then read as *highlighted* — reported within a minute of
  being shown. A standing fact about sixteen items and the transient answer to
  "what am I pointing at" must differ in kind, not degree, so light belongs to
  the pointer alone.

Three make a stored answer safe to keep, and they turn on one observation:
**acting on the advice is what makes the loadout differ from it.** The envelope
now records `worn` — the loadout the run was written against — and a single
staleness bit over it would call an answer stale as its reward for being
followed. Worse, the design that suggests itself next (discard the stored run on
a mismatch) deletes a twelve-minute, four-dollar answer at the moment the user
does what it says. `loadoutDrift` splits the comparison: `applied` slots are
green and their rows struck through, moved slots are named in amber, and the run
is never dropped. Runs are therefore kept rather than overwritten
(`advice/<character>/<timestamp>.json`, a picker once there are two, `Clear` for
the one on screen) — at four dollars each, a second opinion must not be a
decision to destroy the first answer. The store validates every file on read,
skips what it does not recognise, and migrates the pre-history flat file once.

And one **correction to this plan's own premises**: the "Facts this stage builds
on" list says *"No streaming"*. That was true of the invocation, not of the
backend. `claude --output-format stream-json --include-partial-messages
--verbose` emits `thinking_delta` and `text_delta` as they are written, plus its
own `thinking_tokens` estimate — and the **last line of the stream is the same
`type: "result"` envelope `--output-format json` prints on its own**, so adopting
it is a change to the invocation and not to the parsing (`envelopeFrom` reads
both, which also keeps the mock provider and every test working). It matters
because the honest progress this stage shipped — three phases and a clock —
cannot distinguish a working run from a wedged one when the phase reads "asking
the model" for ten minutes. The runner coalesces to four pushes a second and
keeps a 600-character tail, in a fixed-height box: the deltas arrive faster than
a frame, and a box that sized itself to its contents would reflow the panel and
the loadout under it continuously for twelve minutes. Written tokens, never a
percentage.

Also: `Refresh` and `Run advice` now state in a tooltip what they do to a run in
flight and to the stored answer, which was the actual question behind the
feedback — a refresh cannot disturb a run (it holds the snapshot it started
with) and equally cannot make it answer about the newly-read save.

369 tests, 181 story assertions, 14 app assertions.

### Second review pass

Twelve more pieces of feedback. Both of the substantive ones were about *identity*.

**An item's document id includes its attachments.** `itemId` hashes
`relicName`/`relicSeed` — the save's word for a component — and
`augmentName`/`augmentSeed` along with the base and its affixes. So installing the
component the plan asked for changes the worn item's id while changing nothing
about which item it is, and the first drift check reported that as *"Feet now holds
Bloodhound Greaves (was Bloodhound Greaves)"*: useless as a sentence, and the
opposite of the truth, since what happened is that the reader did what the plan
said. The envelope now carries `wornSockets` beside `worn` (a separate field, not a
richer `worn`: changing that value type would fail validation on an already-stored
run and silently discard a four-dollar answer), `loadoutDrift` classifies each
moved slot as an item change or a socket change, and a socket move counts as
**done** when the socketable now installed is the one the plan named — from the
verdict's `targetId` or from `fits`. Telling "re-socketed" from "replaced" needs
the stored name as well as the stored id, which the envelope already had.

**A border is a state; a bar is an annotation.** The container mark had become a
full ring, and it was reported as looking "always highlighted" — twice, the second
time after the ring had been dimmed. Dimming was the wrong fix, because the problem
was never brightness: a border around a cell is how this window says *this one*, so
sixteen standing marks cannot borrow that vocabulary at any opacity. The mark now
takes an edge the highlight never uses. Three shapes were tried in total — corner
flag (invisible at 32 px), full ring (reads as lit), bottom bar — and the sequence
is worth keeping, because each failure was informative and the second one is the
kind that only shows up in front of a user.

The rest, briefly. The drift notices moved to the **top of the Loadout pane**, with
a bordered `DONE`/`CHANGED` stamp under each affected slot's name carrying both a
glyph and a word: the glyph is recognisable in an 84 px column without reading, and
the word settles which of the two it is. The run picker and `Clear` are in the
**header** as well as the advice panel — the panel is below the loadout and scrolls
with it, so on a fourteen-slot character it can be entirely off screen while the
marks it produced are still painted on the gear, which is exactly when "which run
is this?" arises. The hover panel is **centred** on its subject instead of
left-aligned: with two panels the pair used to extend right until it hit the
viewport, at which point `shift` slid the whole thing left, so an item's own panel
sat somewhere different depending on whether the plan had anything to say about it.
(The *seam* between the two panels is deliberately not what gets centred — that
would put the panel describing the item entirely to one side of it.) The empty-slot
`—` now sits on the arrow's line. The advice header wraps instead of pushing `Clear`
out of the panel.

Two changed a decision made earlier in this stage. The expensive and destructive
buttons now explain themselves in the **window's own panel and carry no `title`**:
native `title` takes about a second to appear, renders in the OS's style and
vanishes while being read, and keeping both meant the OS's box landing on top of
ours a second later — with no way to suppress one without the other. And the
streamed reasoning is kept **whole and collapsible** rather than as a
600-character tail. The tail was defended on the grounds that the panel has two
lines to spare and the transcript is not the product; both true, and both beside
the point, because *"why did it decide that"* is a question the finished answer
routinely raises and does not answer. It is expanded while the run is live,
collapsed to one line after, capped in height and scrolling, and not persisted with
the envelope — it is the working-out, not a second answer.

372 tests, 193 story assertions, 14 app assertions.

### Third review pass — the run controls

Four pieces of feedback, all about the two buttons, and the pass removed more code
than it added.

**`Clear` was a delete, and it was in the worst possible place.** It sat beside the
answer and deleted it. Which means the one control a reader reaches for *after
acting on a plan* — "I have done these three, ask me again" — was the one control
that could throw a four-dollar, eight-minute answer away. It is now `New run`:
selects nothing, deletes nothing, puts the open answer away (it stays in the picker)
and brings the Run button and the question box back with it. `--bad` red came off
the hover with the destruction; red is for something actually being lost.

**No `Re-run` beside an answer.** A second opinion costs eight minutes and a few
dollars and — by this stage's own design — does *not* replace the answer next to it,
so a Re-run button there is an expensive misclick with nothing to recommend it.
Asking again is two steps on purpose: `New run`, then `Run advice`.

**The window opens on the empty state.** It used to reopen the newest stored answer
on launch, which put a possibly-stale plan's marks on the gear before the reader had
asked for them, and made *"is this still about what I am wearing?"* the first
question of every session rather than one they chose to ask. So the picker became
the door: it is shown whenever there is anything to choose (a placeholder counts as
a choice), and the empty state says how many answers are kept, because starting
fresh must not read as having lost them.

Two IPC channels went with all that — `getLastAdvice` and `deleteAdvice`. There is
no "open the newest" call any more (`getAdviceHistory` → `getAdvice` is the whole
path in) and nothing in the window deletes a run; the store still has both
functions, and vitest still covers them. Worth stating as a rule since it is easy to
re-add by reflex.

**A re-read must neither open nor close a run.** `load()` fires on every window
focus and will fire on Stage 7C's watcher, so a refresh that dropped the open plan
would take the marks off the gear at the exact moment the user came back from the
game to compare them — and one that *opened* the newest would undo `New run` on the
next focus event. It keeps the selection, and clears it only when the character
changes, where the ids would join onto another loadout entirely. The comparison
needs the previously-read character, which is a **ref**, not the `snapshot` state:
`load` is wired to an event listener and must stay a stable callback.

Also: the three button tooltips were rewritten **out of the app's own vocabulary**.
"The item database is untouched", "compile the dossier", "the loadout it started
with" — every one of those is a sentence for whoever wrote the app. `Refresh` now
says it reads your save file again, names what it picks up, and says what happens to
the answer on screen; `check-stories.mjs` asserts that *dossier*, *envelope*,
*snapshot* and *item database* do not appear in it, because that drift is not
hypothetical. Every control in a toolbar row is **one 30 px height**
(`box-sizing: border-box`) with its label centred by a flex box rather than by
padding — a fixed height plus inherited line-height put the label a pixel low. The
picker is narrower inside the panel (230 px) than in the header (340 px), because at
340 it pushed `New run` onto a second line.

And the streamed reasoning got **a story of its own** (`parts--advice-thinking`,
plus one for the collapsed state after a run). It already had one in the workspace,
which was not the same thing: the advice panel sits under a fourteen-row loadout, so
at 1080 the transcript is off the bottom of the screenshot — as much use as no story
at all.

372 tests, 218 story assertions, 21 app assertions.
