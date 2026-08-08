# Runbook — Grim Dawn Companion Tool

Master plan for building the tool in independent, verifiable stages. Each stage is sized for one focused Claude Code session.

## How to kick off a stage

In a fresh Claude Code session, say:

> Read RUNBOOK.md and implement stage N per its plan in docs/plans/. Verify against the acceptance criteria before finishing.

Each stage plan is self-contained (goal, format facts, deliverables, acceptance criteria, verification commands). After a stage passes verification: tick its box below, commit, and note deviations in an "Outcome" section at the bottom of the stage plan.

## Stages

- [x] **Stage 1 — Scaffold + player.gdc parser** — [docs/plans/stage-01-scaffold-gdc-parser.md](docs/plans/stage-01-scaffold-gdc-parser.md)
  Project scaffold; cipher + character save parser; CLI `parse`. Gate: all block checksums pass on both real saves.
- [x] **Stage 2 — GST parsers** — [docs/plans/stage-02-gst-parsers.md](docs/plans/stage-02-gst-parsers.md)
  Transfer stash + learned blueprints; CLI `stash`, `formulas`. Gate: block 18 checksum passes on the live stash.
- [x] **Stage 3 — Game DB + resolver + settings** — [docs/plans/stage-03-grimtools-db-resolver.md](docs/plans/stage-03-grimtools-db-resolver.md)
  Parse/cache the item DB; resolve save items to names/stats; CLI `db`, `resolve`. Gate: ≥95% of item records resolve — **actual: 100%**.
  Backend pivoted mid-stage: GrimTools publishes no DBR record paths, so item data comes from the game's own `.arz` archives; GrimTools supplies localization only. See the plan's Outcome.
- [x] **Stage 4 — Icon service** — [docs/plans/stage-04-icons.md](docs/plans/stage-04-icons.md)
  Per-item PNGs, cached; CLI `icon`. Gate: 0 missing icons for equipped gear — **actual: 148/148 for everything both characters can reach**, 3,840/3,844 across the whole database.
  Backend pivoted again, as Stage 3 predicted: icons come from the game's own `resources/Items.arc`, not the GrimTools sprite sheet, so the plan's `.png`-path/CSS scheme was moot. No network, and no `sharp` — see the plan's Outcome.
- [ ] **Stage 5 — Context document builder** — [docs/plans/stage-05-context-builder.md](docs/plans/stage-05-context-builder.md)
  Character + DB → markdown context doc for the LLM; CLI `context`.
- [ ] **Stage 6 — AI provider + advise** — [docs/plans/stage-06-ai-advise.md](docs/plans/stage-06-ai-advise.md)
  Provider abstraction; claude-cli default provider; CLI `advise`.
- [ ] **Stage 7 — Electron UI + watcher** — [docs/plans/stage-07-electron-ui.md](docs/plans/stage-07-electron-ui.md)
  Info window (equip grid w/ icons, candidates, Advise button, settings), live save watching.

## Post-v1 backlog (not planned in detail yet)

- ~~Own `.arz` parser backend~~ — **done early, in Stage 3**; it turned out to be the only way to identify save items at all. The `.arc`/`.tex` reader arrived with it in **Stage 4** (`src/core/db/arc.ts`), so all that is left of this item is pointing it at `resources/Text_EN.arc` for localization — a small job that would drop the last GrimTools dependency and make the tool fully offline.
- OpenAI provider behind `AdvisorProvider` (settings toggle).
- electron-builder packaging (dev-mode `npm run dev` is fine until then).
- Nice-to-haves: per-slot "shopping list" view, multi-character comparison, hardcore (`.gsh`) stash support if ever needed.

## Risk log

| Risk | Mitigation | Status |
|---|---|---|
| Save format drift (1.3.0.6 vs 1.2-era specs) | Checksums catch misparses immediately; unknown blocks skipped; warn-not-throw on version fields | Settled empirically by Stage 1 |
| Torn/partial save writes | Checksum + 3× retry + `player.g00` fallback | Designed in (Stage 1/7) |
| GrimTools schema change or unavailability | zod fails loudly; raw download cached; now only localization depends on it, and an `.arc` reader would remove even that | Much reduced (Stage 3) |
| Affix (prefix/suffix) name coverage | Answered: the `.arz` names every affix that has a name (`lootRandomizerName`); only crafting bonuses are nameless, and they are nameless in game too | Closed (Stage 3) |
| Requires a local Grim Dawn install | Unavoidable — record paths exist nowhere else. Auto-detected; `GD_GAME_DIR`/settings override; absence reports a plain message | Accepted (Stage 3) |
| Resistance totals are item-sourced approximations | Labeled as lower bound in context doc; full engine simulation is a non-goal | Accepted |
