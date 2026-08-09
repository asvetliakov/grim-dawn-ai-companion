# Stage 6 — AI provider + advise

## Goal

An `AdvisorProvider` abstraction with two implementations — `claude-cli` (default, uses the user's existing Claude subscription via the local `claude` binary) and a `mock` for tests — wired to CLI `advise --char <name>`. OpenAI remains a stub registered but unimplemented.

## Context

Stage 5B produces the markdown context document (with item IDs). This stage sends it to an AI and returns recommendations, prose + a machine-readable plan. The user's `claude` CLI is v2.1.220 at `~/.local/bin/claude`, authenticated via subscription OAuth (keychain).

**Verified invocation contract** (do not deviate without re-verifying against `claude --help`):

```
claude -p --output-format json --model opus --effort high \
  --tools "" --no-session-persistence \
  --system-prompt "<advisor persona>"
```

- **Pin both `--model` and `--effort`.** Without them the subprocess inherits whatever the user's interactive session or settings happen to specify, which makes two runs of `advise` on the same save silently incomparable. `opus` / `high` are the defaults for this tool (confirmed against `claude --help` on v2.1.220: `--effort <low|medium|high|xhigh|max>`); both belong in `settings.json` (`model`, `effort`) so they are changeable without a code edit, and `advise --model` / `--effort` override per run. Record the resolved pair in `AdvisorResult` so the output says what produced it.
- `xhigh` is worth *measuring* against `high` on the same document rather than assuming: this is a lookup-and-compare task over facts §2–§10 already state, not a search problem. If the recommendations do not change, `high` is the right default.
- Context doc goes over **stdin** (a ~36k-token doc far exceeds ARG_MAX as an argument).
- Stage 5B's builder takes a token budget; **pass one explicitly** rather than inheriting the default, so the prompt size is a property of this stage's contract.
- `--output-format json` → single JSON envelope on stdout; the answer is its `result` field (also has cost/usage fields — surface them).
- `--tools ""` disables tool use → pure one-shot completion. `--no-session-persistence` avoids polluting session history.
- **Never use `--bare`** — it disables the OAuth/keychain auth the subscription depends on.
- `cwd` = `os.tmpdir()` so the subprocess doesn't pick up this repo's CLAUDE.md or any project context.
- Timeout 180s; kill the process group on abort.

## Deliverables

```
src/core/ai/provider.ts    # interface + registry
src/core/ai/claude-cli.ts  # default provider (execa)
src/core/ai/mock.ts        # canned/scripted responses for tests
src/core/ai/openai.ts      # registered stub: available() → false, advise() → clear "not configured" error
src/cli/index.ts           # add `advise --char <name> [--provider id] [--model m] [--question "..."] [--difficulty N]`
test/ai.test.ts
```

```ts
interface AdvisorRequest { contextDoc: string; question?: string }
interface AdvisorResult {
  text: string; provider: string; model?: string;
  structured?: AdvisorPlan;   // parsed from the answer's trailing json block; see below
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}
interface AdvisorProvider {
  readonly id: string;                    // 'claude-cli' | 'openai' | 'mock'
  available(): Promise<boolean>;          // claude-cli: binary found && `claude --version` exits 0
  advise(req: AdvisorRequest, signal?: AbortSignal): Promise<AdvisorResult>;
}
```

Dependency: `execa@^9`.

**System prompt (advisor persona)** — keep in a template file or exported const. It encodes the *procedure*, not just the format, because the value of this tool is holistic loadout reasoning, not per-slot stat comparison. Required content:

- *Persona & trust:* "You are a Grim Dawn build advisor. The dossier states the game version and every game rule you need (resistance caps, difficulty penalties, market tiers). The dossier is authoritative — where your memory of Grim Dawn disagrees (it may predate v1.3 / Fangs of Asterkarn), the dossier wins. Never invent items, augments, or blueprints not present in it."
- *Procedure (in order):*
  1. Read the build profile and skills — identify the build's damage types and defensive skeleton first; every later trade-off is judged against them. The dossier's damage path is already post-conversion (global conversions folded into the flats; skill-scoped conversions stated per skill), so judge every candidate's damage stats against it: an off-type item (damage or +% modifiers outside the build's top types) may be proposed **only as an explicit trade-off that names what is lost**; a candidate whose own conversion or armor piercing feeds a top type is on-type by that fact (a 100% physical→pierce gun is a pierce weapon); `+% damage` of a converted-away input type is worth little — modifiers apply after conversion, to the output type.
  2. Fix effective resistance shortfalls (the matrix's post-penalty band) to cap + the stated overcap target, using the **cheapest degrees of freedom first: augment re-assignment, then components, then gear swaps**. Augment slots are free variables — propose a complete augment assignment, not deltas only.
  3. Optimize the loadout as a whole: a gear swap that *creates* resistance slack elsewhere (e.g. legs covering what two ring augments currently cover) frees those slots — say what to re-slot them with.
  4. Do not trade large damage modifiers matching the build's top damage types for marginal overcap beyond the target; conversely never leave an effective resistance under cap for damage.
  5. Account for set bonuses: a swap that breaks an active set must count the lost bonus in its math; completing a nearly-done set is a first-class move.
  6. Resistances that only reach cap inside the "+maintainable" band (duration buffs like Pneumatic Burst) count — the community plays them at full uptime — but flag any resistance leaning on them by >15 points as *fragile* (buffs drop on death/dispel).
  7. Requirements are a hard constraint on the **post-swap** loadout, not the current one: an outgoing item's +attributes or `-% Requirement` reduction leaves with it, so re-check every joint move against what remains. Then triage by deficit: (a) the post-swap loadout meets everything → the move is legal; (b) a small deficit another proposed item or the unspent attribute points (8 per point) can cover → propose the **enabler combo as one joint move** ("equip X *and* Y — Y's +25 Cunning is what makes X wearable") and list the enablers in the plan; (c) a level or attribute gap that levelling will close → HOLD with the number ("until level 84", "needs 42 more spirit"); (d) a requirement unreachable for this build's attribute line → not a candidate; say SELL if it has no other value — unless the item is exceptional for the build, in which case HOLD flagged as "worth an attribute respec (Tonic of Reshaping — scarce), build decision". Respect the character's iron for purchases.
  8. Socketables are moves with a legality check and a source. Legality: a component or augment may only go to a slot its stated use-on restriction accepts — never propose an illegal socket. Sourcing, cheapest first: (a) a loose copy on hand → free; (b) craftable now per the dossier's blueprints and materials → CRAFT; (c) the only copy installed in another item → Inventor extraction, which **destroys the host item and its augments** — say so explicitly, count the loss, give the destroyed host no other verdict (it cannot also be KEEP/HOLD/SELL), and respect iron for the salvage fee. ADD-COMPONENT on an occupied socket is a *replacement*: the installed component is destroyed and the augment removed — count that loss and re-state the augment to re-apply.
  9. CRAFT and upgrade verdicts must be *affordable now* per the dossier's materials-on-hand and iron; if an upgrade path exists but materials are missing (e.g. an awakened version needing Awakening Ashes the character lacks), the verdict is HOLD with what to farm — never assume unlisted materials. Ascension rolls a random affix at high cost: it may be mentioned as an option, never prescribed as "reroll until you get X".
  10. Weapon compatibility is a hard constraint: never recommend a weapon/off-hand/shield change that violates a pointed attack skill's stated weapon requirement, and treat a wielding-mode change (dual-wield ↔ two-hander ↔ weapon-and-shield) as a build decision to flag explicitly, not a routine swap. Dual wielding needs an enabler and the dossier names the character's: a move that removes the **last** enabler while the recommended weapons are still two one-handers is illegal — re-check post-swap, exactly like requirements. Don't over-value `+% attack/cast/move speed` on a build at the stated caps.
  11. On hardcore characters, weight survivability higher: resist caps and health are non-negotiable before any damage optimization.
  12. Gear is the scope. If unspent skill/devotion/attribute points are listed, note them in one line — do not produce a build guide.
- *Output format:* first the human-readable analysis in markdown — per-slot verdicts with one-line reasons, a **Key moves** section (for each multi-slot combination, a short paragraph with the actual numbers — this is where the legs-frees-both-ring-augments reasoning lives), HOLD (with why), SELL/SALVAGE, and a **projected resistance table** after all recommended changes, computed from the matrix rows. Be decisive; if two options are close, pick one and say why in one line. Then, as the final element of the answer, **exactly one fenced ```json block** — the machine-readable plan, referencing items by their dossier IDs.

The `question` field, when present, is appended as an additional user instruction (e.g. "focus on my weapon choice").

**Structured plan block — the contract with Stage 7.** The trailing ```json block is what the Electron UI consumes to paint verdict chips on an inventory-like grid; the markdown above it is what gets displayed as prose. Shape (zod-validated in `parseAdvice`):

```ts
interface AdvisorPlan {
  verdicts: {
    slot: string;
    itemId: string;               // dossier item ID of what's in the slot ('' if empty)
    verdict: 'KEEP' | 'EQUIP' | 'RE-AUGMENT' | 'ADD-COMPONENT' | 'BUY-AUGMENT' | 'CRAFT';
    target?: string;              // EQUIP: candidate's itemId; BUY/CRAFT/RE-AUGMENT: exact dossier name
    enablers?: string[];          // itemIds whose joint equip satisfies this move's requirements
    componentFrom?: string;       // ADD-COMPONENT via extraction: itemId of the host — the host is DESTROYED
    reason: string;
  }[];
  hold: { itemId: string; reason: string; until?: string }[];  // until: "level 84" / "42 more spirit"
  sell: string[];                 // itemIds
  projectedResistances?: Record<string, number>;
}
```

Item identity is the Stage 5B item ID, never the display name (names collide; IDs don't). `AdvisorResult` gains `structured?: AdvisorPlan`. Parsing rules: take the *last* fenced json block in the answer; on zod failure, set `structured` undefined and keep the text — the CLI prints text either way, the UI degrades to prose. Unit-test the extraction against the mock provider's canned answer, including the degraded path.

Errors must be actionable: binary not found → "claude CLI not found — install Claude Code or switch provider"; non-zero exit → include stderr tail; timeout → say so; JSON parse failure → show first 200 chars of stdout.

## Acceptance criteria

1. Unit tests (mock provider + mocked execa): prompt assembly (system prompt + stdin doc + question), JSON envelope parsing, each error path (missing binary, non-zero exit, timeout, malformed JSON).
2. Live: `npm run cli -- advise --char _Suchka` completes in < ~3 min, prints per-slot verdicts + Key moves + HOLD + SELL referencing real items, and yields a valid `structured` plan (CLI prints "plan: N verdicts" or "plan: not parseable — text only").
3. Reasoning quality (sanity-read, not scripted): the Key moves section cites actual numbers from the dossier's resistance matrix; the answer includes a projected resistance table; verdicts weigh damage-type fit against the dossier's post-conversion build path (a pure stat-stick swap justified only by a small resist gain on an overcapped resistance should not appear, and no off-type damage recommendation appears without an explicit stated trade-off).
4. No hallucinated items — mechanically checked: every `itemId` in the structured plan (verdicts, enablers, `componentFrom`, hold, sell) exists in the context doc's ID set (the advise command verifies this and warns otherwise); spot-check free-text names too.
4b. Requirements respected — sanity-read: no EQUIP verdict targets a candidate whose dossier annotation says the post-swap requirements fail, unless the verdict lists enablers that cover the gap; anything annotated `needs level N` lands in HOLD with `until`, not in a verdict.
4c. Extraction is destruction — mechanically checked: any `componentFrom` host carries no other verdict and appears in neither `hold` nor `sell` (it ceases to exist); the advise command verifies this and warns otherwise.
4d. Slot legality — mechanically checked: for every ADD-COMPONENT/BUY-AUGMENT/RE-AUGMENT verdict, the named socketable's `allowedSlots` accepts the target slot's item class (the advise command resolves the name against the DB and warns on an illegal socket, same spirit as the ID check).
5. `advise --provider openai` → clean "not configured" message, exit code 1.
6. `advise --question "what should I farm next?"` visibly steers the answer.
7. Usage/cost line printed after the answer when available.
8. `npm test` + `npm run typecheck` green.

## Verification

```bash
npm test && npm run typecheck
npm run cli -- advise --char _Suchka
npm run cli -- advise --char _Suchka --question "focus only on resistances"
```

## Outcome

Done, and every acceptance criterion passes. Two live runs against `_Suchka` (level 82 Reaver, Ultimate),
both clean on all four mechanical checks.

### Deviations from the plan

- **No `execa`.** The plan named it as a dependency; `CLAUDE.md`'s "zero runtime dependencies beyond
  `commander` + `zod`" wins. `node:child_process.spawn` does the whole job in ~90 lines, and the
  `spawn` function is injectable (`ClaudeCliOptions.spawn`), which is what makes every failure path —
  missing binary, non-zero exit, timeout, garbage stdout, abort — testable without a subprocess.
- **The timeout was wrong by 3×, and it was measured rather than argued.** The plan said 180s and the
  acceptance criterion said "< ~3 min". The real figure for a full dossier at `opus` / `high` is
  **496s** (the second run, 487s). 180s and the 300s that first replaced it both killed a healthy run —
  the first live attempt died at the 300s ceiling with nothing to show. `DEFAULT_TIMEOUT_MS` is now
  **900s**: a runaway ceiling, not an expectation. `--timeout` and `advisorTimeoutSeconds` override it.
  Nothing about this is pathological — ~36k tokens in and ~40k tokens out is simply an eight-minute
  request, and the answer is worth the wait ($1.07 and $1.68 for the two runs).
- **`SWAP-COMPONENT` joined the verdict enum.** §11 of the context document already tells the model to
  use it, and the plan's own step 8 describes the mechanic ("ADD-COMPONENT on an occupied socket is a
  *replacement*"). Leaving it out of the enum would have failed zod on a verdict the document asked for.
- **`--effort` is a settings field and a flag**, alongside `model`, exactly as the plan required for
  the model; `advisorTimeoutSeconds` was added for the same reason.
- **Extra CLI affordances**: `--save-context` (write the exact document that was sent), `--dry-run`
  (build and report without spending a call), `--timeout`. The first two paid for themselves during
  verification.
- **`ContextDoc` gained `itemsById`** (id → `ResolvedItem`, alongside the existing id → name
  `itemIds`). The hallucination and slot-legality checks need the item, not just its name; Stage 7
  will want the same index for grid highlighting. `documentSocketables()` was added to `builder.ts`
  for the same reason: the legality check must run against **what the document offered** (166 for
  `_Suchka`), not against the whole database — a component the dossier never showed is a
  hallucination even though the game has one.
- **`xhigh` was not measured against `high`.** The plan flagged it as worth measuring; at ~8 minutes
  and ~$1.50 a run that experiment costs more than it informs right now, and `high` produced answers
  with no visible reasoning gap. Left as a backlog note rather than silently claimed.

### What the live runs showed

`advise --char _Suchka` — 496s, 18 verdicts (10 BUY-AUGMENT, 3 ADD-COMPONENT, 2 RE-AUGMENT, 2 KEEP,
1 EQUIP), 12 HOLD, 36 SELL, ~40k output tokens. All four mechanical checks clean: every item id in
the plan exists in the document's 139-id set, all 15 socket verdicts legal against `allowedSlots`,
no extraction host reused (it proposed no extraction at all — "no Inventor extraction, no item
destroyed"), every EQUIP target annotated **meets**.

The reasoning gate (criterion 3) is the interesting one, and it passed on substance rather than
shape. The answer opened by reading the build (`Pierce + Bleeding`, both weapons at 100% armor
piercing → "on-type by that fact", and Quillthrower's 50% Pierce→Acid called out as *anti*-build,
not merely off-type — exactly the 5A.5 conversion path doing its job). The Key moves section is
built out of matrix numbers: 3× Wight Skin Powder feeding Aether at **154 effective, +74 over cap**
while Bleeding sat at 38 (−42), seven empty armour augment sockets, and Fire/Cold/Lightning reaching
74 *only* through Elemental Awakening — leaning on the maintainable band by 30 points, which it
flagged fragile against the plan's 15-point rule without being asked twice. The one gear swap
(Bloodmoon → Maiven's Lens) was priced explicitly in damage ("roughly a 3% loss" against +45 points
in the two deficit resistances) and its post-swap requirement re-check was spelled out including
that a *devotion* reduction stays when the item leaves. It also said plainly what it could not
derive — Bleeding lands 2 short and no augment in §9 fixes it; §3 reports no attack-speed total, so
the 200% cap could not be checked — which is the behaviour §11 asks for and the harder one to get.

`advise --question "focus only on resistances"` — 487s, visibly steered: retitled "Resistance-First
Gear Plan", opens by acknowledging the instruction, and reaches a different loadout (2 EQUIP instead
of 1, 18 SELL instead of 36). It independently noticed something §8 exists to surface: the helm's
Runestone is a single instance, so extracting it would destroy the helm.

The usage line under-reported input by four orders of magnitude on the first run ("2 in") — the
envelope puts a cached dossier in `cache_creation_input_tokens` / `cache_read_input_tokens`, not in
`input_tokens`. Summed now, and unit-tested.
