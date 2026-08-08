# Stage 6 — AI provider + advise

## Goal

An `AdvisorProvider` abstraction with two implementations — `claude-cli` (default, uses the user's existing Claude subscription via the local `claude` binary) and a `mock` for tests — wired to CLI `advise --char <name>`. OpenAI remains a stub registered but unimplemented.

## Context

Stage 5B produces the markdown context document (with item IDs). This stage sends it to an AI and returns recommendations, prose + a machine-readable plan. The user's `claude` CLI is v2.1.220 at `~/.local/bin/claude`, authenticated via subscription OAuth (keychain).

**Verified invocation contract** (do not deviate without re-verifying against `claude --help`):

```
claude -p --output-format json --model sonnet \
  --tools "" --no-session-persistence \
  --system-prompt "<advisor persona>"
```

- Context doc goes over **stdin** (a 20k-token doc exceeds ARG_MAX comfort as an argument).
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
  1. Read the build profile and skills — identify the build's damage types and defensive skeleton first; every later trade-off is judged against them.
  2. Fix effective resistance shortfalls (the matrix's post-penalty band) to cap + the stated overcap target, using the **cheapest degrees of freedom first: augment re-assignment, then components, then gear swaps**. Augment slots are free variables — propose a complete augment assignment, not deltas only.
  3. Optimize the loadout as a whole: a gear swap that *creates* resistance slack elsewhere (e.g. legs covering what two ring augments currently cover) frees those slots — say what to re-slot them with.
  4. Do not trade large damage modifiers matching the build's top damage types for marginal overcap beyond the target; conversely never leave an effective resistance under cap for damage.
  5. Account for set bonuses: a swap that breaks an active set must count the lost bonus in its math; completing a nearly-done set is a first-class move.
  6. Resistances that only reach cap inside the "+maintainable" band (duration buffs like Pneumatic Burst) count — the community plays them at full uptime — but flag any resistance leaning on them by >15 points as *fragile* (buffs drop on death/dispel).
  7. Respect attribute/level requirements and the character's iron for purchases.
  8. CRAFT and upgrade verdicts must be *affordable now* per the dossier's materials-on-hand and iron; if an upgrade path exists but materials are missing (e.g. an awakened version needing Awakening Ashes the character lacks), the verdict is HOLD with what to farm — never assume unlisted materials. Ascension rolls a random affix at high cost: it may be mentioned as an option, never prescribed as "reroll until you get X".
  9. Weapon compatibility is a hard constraint: never recommend a weapon/off-hand/shield change that violates a pointed attack skill's stated weapon requirement, and treat a wielding-mode change (dual-wield ↔ two-hander ↔ weapon-and-shield) as a build decision to flag explicitly, not a routine swap.
  10. On hardcore characters, weight survivability higher: resist caps and health are non-negotiable before any damage optimization.
  11. Gear is the scope. If unspent skill/devotion/attribute points are listed, note them in one line — do not produce a build guide.
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
    reason: string;
  }[];
  hold: { itemId: string; reason: string }[];
  sell: string[];                 // itemIds
  projectedResistances?: Record<string, number>;
}
```

Item identity is the Stage 5B item ID, never the display name (names collide; IDs don't). `AdvisorResult` gains `structured?: AdvisorPlan`. Parsing rules: take the *last* fenced json block in the answer; on zod failure, set `structured` undefined and keep the text — the CLI prints text either way, the UI degrades to prose. Unit-test the extraction against the mock provider's canned answer, including the degraded path.

Errors must be actionable: binary not found → "claude CLI not found — install Claude Code or switch provider"; non-zero exit → include stderr tail; timeout → say so; JSON parse failure → show first 200 chars of stdout.

## Acceptance criteria

1. Unit tests (mock provider + mocked execa): prompt assembly (system prompt + stdin doc + question), JSON envelope parsing, each error path (missing binary, non-zero exit, timeout, malformed JSON).
2. Live: `npm run cli -- advise --char _Suchka` completes in < ~3 min, prints per-slot verdicts + Key moves + HOLD + SELL referencing real items, and yields a valid `structured` plan (CLI prints "plan: N verdicts" or "plan: not parseable — text only").
3. Reasoning quality (sanity-read, not scripted): the Key moves section cites actual numbers from the dossier's resistance matrix; the answer includes a projected resistance table; verdicts weigh damage-type fit (a pure stat-stick swap justified only by a small resist gain on an overcapped resistance should not appear).
4. No hallucinated items — mechanically checked: every `itemId` in the structured plan exists in the context doc's ID set (the advise command verifies this and warns otherwise); spot-check free-text names too.
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
