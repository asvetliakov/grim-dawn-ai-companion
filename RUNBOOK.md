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
  Follow-on (same session): the `.arc` reader was pointed at `Text_<LOCALE>.arc`, which **removed the last download**. The tool is now fully offline, with 20,322 name tags instead of 16,246 and all 13 shipped languages instead of one.
- [x] **Stage 5A — Game mechanics layer** — [docs/plans/stage-05a-mechanics.md](docs/plans/stage-05a-mechanics.md)
  DB learns skills/devotion/sets/affix-stats; per-character resistance matrix + build damage profile; CLI `aggregates`. Split out of Stage 5 after the 2026-08 plan review: holistic advice (augment slots as free variables, damage-vs-resist trade-offs, buff-aware totals) is impossible from item base stats alone.
  Gate: Elemental Awakening bands as maintainable at **effective rank 12** (11 invested + the relic's +1 to all Nightblade skills); the profile ranks **pierce then bleeding**. Four plan facts were wrong and the data won — most importantly **the difficulty penalty is in the game files and is not uniform** (Ultimate: −50 elemental/pierce/acid, −25 aether/chaos/vitality/bleeding, **0 physical**), read from `balancingadjustment_mp+difficulty_players01.dbr` rather than hardcoded; and **armour is localized, not pooled** — six body parts with hit weights, absorption multiplicative on a 70% base. See the plan's Outcome.
- [x] **Stage 5A.2 — Item requirements & character attributes** — [docs/plans/stage-05a2-requirements.md](docs/plans/stage-05a2-requirements.md)
  Attribute requirements are **equation-derived, not stored**: `itemCostName` → `records/game/itemcostformulas*.dbr`, evaluated at `itemLevel` per slot class (spears ride `melee2h`; medals require nothing); level gates are explicit and affix-inclusive (`max(base, prefix, suffix)`); `-% Requirement` reductions are a scope × attribute matrix. Aggregate gains attribute totals (save base + mastery bars + gear ± %), OA/DA contributions, and `checkRequirements`.
  Gate: **every equipped item on both characters passes the check** — and the first run failed it, catching a real bug (jewelry's `totalAttCount` stat count inflated by non-stat keys). See the plan's Outcome.
- [ ] **Stage 5B — Context document builder** — [docs/plans/stage-05-context-builder.md](docs/plans/stage-05-context-builder.md)
  Character + DB + aggregates (incl. 5A.2 requirements/attributes) → markdown context doc for the LLM, self-contained incl. game rules; CLI `context`. Candidates carry requirement annotations (`meets` / `short 42 physique` / `needs level 84 (HOLD)`).
- [ ] **Stage 6 — AI provider + advise** — [docs/plans/stage-06-ai-advise.md](docs/plans/stage-06-ai-advise.md)
  Provider abstraction; claude-cli default provider; CLI `advise`. Requirement handling is a hard constraint on the post-swap loadout: enabler combos, HOLD-until-level/attribute, SELL only when build-unreachable.
- [ ] **Stage 7 — Electron UI + watcher** — [docs/plans/stage-07-electron-ui.md](docs/plans/stage-07-electron-ui.md)
  Info window (equip grid w/ icons, candidates, Advise button, settings), live save watching.

## Post-v1 backlog (not planned in detail yet)

- ~~Own `.arz` parser backend~~ / ~~`.arc` reader~~ / ~~drop the last download~~ — **all done**, across Stages 3–4 and the follow-on after Stage 4. The tool now reads only the installed game and makes **no network requests at all**.
- **Grammatical agreement in gendered locales.** The text files encode declension: a noun opens with the gender it *is* (`[ms]`, `[fs]`, `[ns]`, `[np]`), an adjective spells out every form it *could take* (`[ms]искусный[fs]искусная[ns]искусное[np]искусные`), and the engine matches them. `cleanText` currently keeps the first form, so Russian reads "искусный печатка" where the game says "искусная печатка". Doing it properly means carrying the base item's gender on `DbItem` and picking the affix variant in `resolve.ts` — ~25 lines, affects 365 adjectival tags, and nothing at all in English.
- **Mod support.** With text and icons both coming from `.arc`/`.arz` files, a mod's `mods/<name>/database/*.arz` + `resources/*.arc` would slot into the same merge (the save files already record which mod they belong to). Untried; the Crucible (`survivalmode`) is the only mod installed here.
- **Ascendant Altar: ascension advice (gdx3).** Awakening is deterministic and *is* wired into stages 5A/5B (recipes carry reagents; "awakened version exists" is a HOLD signal). Ascension is not: `ItemAscensionFormula` rolls a random ascended affix from per-slot tables (`affixWeight`/`masteryWeight` 600/400) for five material types + 250k iron, with reroll formulas on top — advice richer than "it exists and is a gamble" (e.g. EV reasoning over the slot's affix table, themed swap lists in `ascensionaffixswaplists/`) is deliberately deferred.
- **Aggregate fidelity round 2:** count item-granted skills (`itemSkillName` actives/procs) and item skill modifiers (`modifierSkillName<N>`) in the aggregates — Stage 5A names both but sums neither. Also: model `Skill_Transmuter` as the skill-rewriting mechanic it is rather than banding it like a modifier, and extend the damage profile / armour / non-damage-resistance figures past permanent sources. (+skills rank boosts were promoted into Stage 5A scope during the 2026-08 plan review, and effective ranks are computed there.)
- OpenAI provider behind `AdvisorProvider` (settings toggle).
- electron-builder packaging (dev-mode `npm run dev` is fine until then).
- Nice-to-haves: per-slot "shopping list" view, multi-character comparison, hardcore (`.gsh`) stash support if ever needed.

## Risk log

| Risk | Mitigation | Status |
|---|---|---|
| Save format drift (1.3.0.6 vs 1.2-era specs) | Checksums catch misparses immediately; unknown blocks skipped; warn-not-throw on version fields | Settled empirically by Stage 1 |
| Torn/partial save writes | Checksum + 3× retry + `player.g00` fallback | Designed in (Stage 1/7) |
| ~~GrimTools schema change or unavailability~~ | Nothing is downloaded any more — names come from the game's own `Text_<LOCALE>.arc` | **Closed** (after Stage 4) |
| Affix (prefix/suffix) name coverage | Answered: the `.arz` names every affix that has a name (`lootRandomizerName`); only crafting bonuses are nameless, and they are nameless in game too | Closed (Stage 3) |
| Requires a local Grim Dawn install | Unavoidable — record paths exist nowhere else. Auto-detected; `GD_GAME_DIR`/settings override; absence reports a plain message | Accepted (Stage 3) |
| Resistance totals are approximations | Stage 5A aggregates items + affix stats + components + augments + sets + passive/toggled/maintainable skills + devotion, banded by reliability; +skills rank boosts *are* folded in (effective ranks); remaining gaps (item-granted skills, item skill modifiers, procs/potions/pets) are *listed as exclusions* in the output rather than silently missing. Full engine simulation stays a non-goal | Narrowed (Stage 5A) |
