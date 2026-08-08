# Runbook — Grim Dawn Companion Tool

Master plan for building the tool in independent, verifiable stages. Each stage is sized for one focused Claude Code session.

## How to kick off a stage

In a fresh Claude Code session, say:

> Read RUNBOOK.md and implement stage N per its plan in docs/plans/. Verify against the acceptance criteria before finishing.

Each stage plan is self-contained (goal, format facts, deliverables, acceptance criteria, verification commands). After a stage passes verification: tick its box below, commit, and note deviations in an "Outcome" section at the bottom of the stage plan.

## Stages

- [ ] **Stage 1 — Scaffold + player.gdc parser** — [docs/plans/stage-01-scaffold-gdc-parser.md](docs/plans/stage-01-scaffold-gdc-parser.md)
  Project scaffold; cipher + character save parser; CLI `parse`. Gate: all block checksums pass on both real saves.
- [ ] **Stage 2 — GST parsers** — [docs/plans/stage-02-gst-parsers.md](docs/plans/stage-02-gst-parsers.md)
  Transfer stash + learned blueprints; CLI `stash`, `formulas`.
- [ ] **Stage 3 — GrimTools DB + resolver + settings** — [docs/plans/stage-03-grimtools-db-resolver.md](docs/plans/stage-03-grimtools-db-resolver.md)
  Fetch/cache/parse the item DB; resolve save items to names/stats; CLI `db`, `resolve`. Gate: ≥95% of item records resolve.
- [ ] **Stage 4 — Icon service** — [docs/plans/stage-04-icons.md](docs/plans/stage-04-icons.md)
  Sprite-sheet slicing to per-item PNGs; CLI `icon`.
- [ ] **Stage 5 — Context document builder** — [docs/plans/stage-05-context-builder.md](docs/plans/stage-05-context-builder.md)
  Character + DB → markdown context doc for the LLM; CLI `context`.
- [ ] **Stage 6 — AI provider + advise** — [docs/plans/stage-06-ai-advise.md](docs/plans/stage-06-ai-advise.md)
  Provider abstraction; claude-cli default provider; CLI `advise`.
- [ ] **Stage 7 — Electron UI + watcher** — [docs/plans/stage-07-electron-ui.md](docs/plans/stage-07-electron-ui.md)
  Info window (equip grid w/ icons, candidates, Advise button, settings), live save watching.

## Post-v1 backlog (not planned in detail yet)

- Own `.arz`/`.arc`/`.tex` parser backend implementing `GameDb` — full offline independence from GrimTools, complete vendor/affix coverage from the user's own install. (Research pointers live in stage 3's plan appendix.)
- OpenAI provider behind `AdvisorProvider` (settings toggle).
- electron-builder packaging (dev-mode `npm run dev` is fine until then).
- Nice-to-haves: per-slot "shopping list" view, multi-character comparison, hardcore (`.gsh`) stash support if ever needed.

## Risk log

| Risk | Mitigation | Status |
|---|---|---|
| Save format drift (1.3.0.6 vs 1.2-era specs) | Checksums catch misparses immediately; unknown blocks skipped; warn-not-throw on version fields | Settled empirically by Stage 1 |
| Torn/partial save writes | Checksum + 3× retry + `player.g00` fallback | Designed in (Stage 1/7) |
| GrimTools schema change or unavailability | zod fails loudly; raw download cached; .arz backend is the long-term hedge | Open |
| Affix (prefix/suffix) name coverage in GrimTools dump unconfirmed | Stage 3 coverage report answers it; fallback: derive from record filename tail | Open until Stage 3 |
| Resistance totals are item-sourced approximations | Labeled as lower bound in context doc; full engine simulation is a non-goal | Accepted |
