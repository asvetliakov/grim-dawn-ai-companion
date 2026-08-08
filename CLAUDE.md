# Grim Dawn Companion Tool

A macOS-native desktop companion for Grim Dawn (the game runs under CrossOver; this tool runs natively). It parses character saves, knows the game item database (incl. faction vendor augments per reputation tier), shows equipped/available gear with icons, and on demand compiles a context document and asks an AI (Claude CLI by default) for equip/replace/hold recommendations.

## How work is organized

Implementation runs in ordered stages, one focused session each. **Start every implementation session by reading `RUNBOOK.md`**, then the stage plan it points to under `docs/plans/`. Stage plans are self-contained — trust them over re-deriving format details. When a stage is done and verified, tick its checkbox in `RUNBOOK.md` and note any deviations in the stage plan's "Outcome" section (add one if needed).

## Stack & conventions

- TypeScript ^5.9, `"type": "module"`, strict mode. Node v24 on this machine.
- All logic lives in `src/core/` — **plain Node, zero Electron imports**. The dev CLI (`src/cli/index.ts`, run via `npm run cli -- <cmd>`) and vitest exercise it. Electron (`src/main`, `src/preload`, `src/renderer`) arrives only in Stage 7 and stays a thin consumer.
- Native modules (sharp) are used only in Node contexts (CLI, Electron main). The renderer gets icons via the `gdicon://` custom protocol — never import sharp in the renderer.
- Tests: vitest. Real save files are the fixtures (paths below); tests needing stability snapshot-copy them into git-ignored `test/fixtures/` on first run.
- Key swap seams — keep these interfaces clean: `GameDb` (`src/core/db/types.ts`; GrimTools backend now, own .arz parser later) and `AdvisorProvider` (`src/core/ai/provider.ts`; claude-cli now, openai later).

## Machine-specific paths

- Game install (v1.3.0.6, all 3 expansions):
  `~/Library/Application Support/CrossOver/Bottles/Steam/drive_c/Program Files (x86)/Steam/steamapps/common/Grim Dawn`
- **Live saves** (Steam Cloud userdata path — this user's authoritative one):
  `~/Library/Application Support/CrossOver/Bottles/Steam/drive_c/Program Files (x86)/Steam/userdata/42909985/219990/remote/save/`
  - Characters: `main/_Suchka/player.gdc` (primary test fixture), `main/_abcdef/player.gdc`
  - Shared: `transfer.gst` (transfer stash), `formulas.gst` (learned blueprints)
- Tool's own data: `~/Library/Application Support/gd-companion/` (settings.json, `cache/<gameVersion>/`).
- Don't touch `~/Documents` — it's TCC-protected for the shell and not needed (saves are in userdata).

## Domain gotchas (hard-won; do not re-litigate)

- Save files use a seeded XOR stream cipher; **every block ends with a checksum that must equal the running cipher state**. A passing checksum is proof the parser consumed the block correctly — treat checksum assertions as the primary test. Unknown block IDs must be skipped (cipher state still advanced), never fatal.
- The cipher state advances over **ciphertext** bytes, not plaintext. Block lengths are read XOR-state **without** advancing.
- `transfer.gst` item X/Y coordinates are **floats**; `player.gdc` inventory/stash X/Y are **i32**. This is the classic porting bug.
- Faction reputation: array index = faction identity (no names in the save); tier thresholds Friendly ≥1501, Respected ≥5001, Honored ≥10001, Revered ≥25000. "Trusted" is a rep level but NOT a vendor market tier.
- Items in saves are DBR record paths + a seed — all display names/stats/icons come from the game DB (GrimTools dump), resolved via `src/core/resolve.ts`.
- The game writes saves event-driven and non-atomically: on checksum failure, retry (torn write), then fall back to `player.g00` rotation backups.
- **Never commit game-derived data** (GrimTools downloads, extracted assets, save copies) — `.gitignore` covers it; keep it that way. Ship code, not data. Credit GrimTools (Dammitt) in UI/README; fetch its dump at most once per game-version bump.
- `claude` CLI invocation: pipe the context doc via **stdin**, use `-p --output-format json --tools "" --no-session-persistence`, cwd = tmpdir, 180s timeout. Never use `--bare` (it disables the subscription OAuth this tool depends on).

## Verification commands

```bash
npm test                                  # vitest suite
npm run typecheck                         # tsc --noEmit
npm run cli -- parse  <path>/player.gdc   # stage 1: checksums + character summary
npm run cli -- stash                      # stage 2
npm run cli -- resolve --char _Suchka     # stage 3: resolution coverage report
npm run cli -- context --char _Suchka     # stage 5: the LLM context doc
npm run cli -- advise --char _Suchka      # stage 6: live AI recommendations
npm run dev                               # stage 7: Electron window
```
