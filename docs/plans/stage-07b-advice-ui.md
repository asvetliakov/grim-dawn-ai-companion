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

New deps (pure JS, ESM):

- `react-markdown@^10` + `remark-gfm@^4` — renders the model-authored answer to React elements with **no raw-HTML pass-through** (do not add `rehype-raw`); GFM gives tables/strikethrough. This is why react-markdown over marked: marked emits an HTML string and would need DOMPurify.
- `lucide-react` — action badge icons.

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
