# Stage 6 — AI provider + advise

## Goal

An `AdvisorProvider` abstraction with two implementations — `claude-cli` (default, uses the user's existing Claude subscription via the local `claude` binary) and a `mock` for tests — wired to CLI `advise --char <name>`. OpenAI remains a stub registered but unimplemented.

## Context

Stage 5 produces the markdown context document. This stage sends it to an AI and returns recommendations. The user's `claude` CLI is v2.1.220 at `~/.local/bin/claude`, authenticated via subscription OAuth (keychain).

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
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}
interface AdvisorProvider {
  readonly id: string;                    // 'claude-cli' | 'openai' | 'mock'
  available(): Promise<boolean>;          // claude-cli: binary found && `claude --version` exits 0
  advise(req: AdvisorRequest, signal?: AbortSignal): Promise<AdvisorResult>;
}
```

Dependency: `execa@^9`.

**System prompt (advisor persona)** — keep in a template file or exported const, roughly: *"You are a Grim Dawn build advisor (game version 1.3, all expansions). You receive a character dossier. For each equipment slot output a table row: slot | current | verdict (KEEP / EQUIP <item> / BUY-AUGMENT <name> / CRAFT <blueprint>) | one-line reason. Then a HOLD list (keep for later) and a SELL/SALVAGE list. Prioritize: resistance caps, then health/OA/DA, then damage synergy with the listed skills. Respect the stated difficulty. Be decisive; don't hedge. If two options are close, pick one and say why in one line. Do not invent items not present in the dossier."*
The `question` field, when present, is appended as an additional user instruction (e.g. "focus on my weapon choice").

Errors must be actionable: binary not found → "claude CLI not found — install Claude Code or switch provider"; non-zero exit → include stderr tail; timeout → say so; JSON parse failure → show first 200 chars of stdout.

## Acceptance criteria

1. Unit tests (mock provider + mocked execa): prompt assembly (system prompt + stdin doc + question), JSON envelope parsing, each error path (missing binary, non-zero exit, timeout, malformed JSON).
2. Live: `npm run cli -- advise --char _Suchka` completes in < ~3 min, prints per-slot verdict table + HOLD + SELL lists that reference real items from the character (sanity-read the output).
3. `advise --provider openai` → clean "not configured" message, exit code 1.
4. `advise --question "what should I farm next?"` visibly steers the answer.
5. Usage/cost line printed after the answer when available.
6. `npm test` + `npm run typecheck` green.

## Verification

```bash
npm test && npm run typecheck
npm run cli -- advise --char _Suchka
npm run cli -- advise --char _Suchka --question "focus only on resistances"
```
