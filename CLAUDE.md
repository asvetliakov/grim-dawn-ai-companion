# Grim Dawn Companion Tool

A macOS-native desktop companion for Grim Dawn (the game runs under CrossOver; this tool runs natively). It parses character saves, knows the game item database (incl. faction vendor augments per reputation tier), shows equipped/available gear with icons, and on demand compiles a context document and asks an AI (Claude CLI by default) for equip/replace/hold recommendations.

## How work is organized

Implementation runs in ordered stages, one focused session each. **Start every implementation session by reading `RUNBOOK.md`**, then the stage plan it points to under `docs/plans/`. Stage plans are self-contained — trust them over re-deriving format details. When a stage is done and verified, tick its checkbox in `RUNBOOK.md` and note any deviations in the stage plan's "Outcome" section (add one if needed).

## Stack & conventions

- TypeScript ^5.9, `"type": "module"`, strict mode. Node v24 on this machine.
- All logic lives in `src/core/` — **plain Node, zero Electron imports**. The dev CLI (`src/cli/index.ts`, run via `npm run cli -- <cmd>`) and vitest exercise it. Electron (`src/main`, `src/preload`, `src/renderer`) arrives only in Stage 7 and stays a thin consumer.
- **Zero runtime dependencies beyond `commander` + `zod`.** The `.arz`/`.arc` readers, LZ4, the DDS decoder and the PNG encoder are all hand-written against `node:zlib` and friends; Stage 4 dropped the planned `sharp` because there was nothing left for it to do (see its Outcome). No native modules means no Electron ABI rebuilds. The renderer gets icons via the `gdicon://` custom protocol, which is `createIconService().getIconPng` in the main process.
- Tests: vitest. Real save files are the fixtures (paths below); tests needing stability snapshot-copy them into git-ignored `test/fixtures/` on first run.
- Key swap seams — keep these interfaces clean: `GameDb` (`src/core/db/types.ts`; backed entirely by the installed game — `.arz` records, `.arc` text and icons) and `AdvisorProvider` (`src/core/ai/provider.ts`; claude-cli now, openai later).
- **The tool makes no network requests.** Everything comes from the install; `src/` contains no `fetch`. Advice calls (Stage 6) shell out to the `claude` CLI, which is the one exception and goes through `AdvisorProvider`. Don't reintroduce a data download — a published dump lags the installed build, which is the mistake stages 3 and 4 each had to undo.

## Machine-specific paths

- Game install (v1.3.0.6, all 3 expansions) — **required**, it is the item database:
  `~/Library/Application Support/CrossOver/Bottles/Steam/drive_c/Program Files (x86)/Steam/steamapps/common/Grim Dawn`
  Auto-detected; override with `GD_GAME_DIR` or `gameDir` in settings.json.
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
- Items in saves are DBR record paths + a seed — all display names/stats/icons come from the game DB, resolved via `src/core/resolve.ts`.
- **Icons come from the game, not GrimTools.** `DbItem.iconPath` is the DBR `bitmap` field — an in-archive `.tex` path (`items/enchants/enchantm_black.tex`). Its first segment names the `.arc` (`resources/Items.arc`), the rest is the entry; search gdx3 → gdx2 → gdx1 → base, same last-wins order as the `.arz` merge. A `.tex` is a 12-byte `TEX\x02` wrapper around a DDS whose magic reads `DDSR`; item icons are always uncompressed **BGRA** (never DXT), masks are all zero, rows top-down. Do not re-add the GrimTools sprite sheet / `itemdb.css` — it is keyed on a many-to-one `bitmap` filename and shows the wrong art where records reuse it. See stage 4's Outcome.
- **GrimTools publishes no DBR record paths** (verified: zero `records/` strings in `itemdb.js`; its `bitmap` field is many-to-one because records reuse art). Item identity therefore comes from the game's own `database/*.arz` archives, merged base → gdx1 → gdx2 → gdx3 last-wins. Do not re-add `itemdb.js`; it is 8.7 MB and carries nothing we need. See stage 3's Outcome.
- **Names come from `resources/Text_<LOCALE>.arc`** — plain `key=value` files, UTF-8, CRLF, `#` comments, BOM on the base archive's first file; merged in the same load order as the `.arz`. 20,322 tags against the 16,246 in GrimTools' `l10n/en.js` that this replaced, and current rather than dump-lagged. 13 locales ship with the game; `settings.locale` picks one and the cache is keyed per language (`db-<locale>.json`) with icons shared across them.
- Gendered locales mark grammar inline: a noun opens with what it *is* (`[ms]`, `[np]`), an adjective spells out every form it *could take* (`[ms]искусный[fs]искусная…`). `cleanText` drops the noun's marker and keeps an adjective's first form; real agreement is a backlog item.
- Game version comes from a NUL-terminated `v1.3.0.6` string in `Engine.dll` (unique under a version-shaped, NUL-terminated pattern). Any published dump reports *its own* version and lags the install.
- The game writes saves event-driven and non-atomically: on checksum failure, retry (torn write), then fall back to `player.g00` rotation backups.
- **Never commit game-derived data** (extracted assets, icon PNGs, save copies) — `.gitignore` covers it; keep it that way. Ship code, not data. Game data is © Crate Entertainment; credit them in the UI/README.
- **The difficulty resistance penalty is in the game data and is not uniform.** `records/game/balancingadjustment_mp+difficulty_players01.dbr` (`AttributePak`) holds `defensive*` arrays 12 long = 3 difficulties × 4 player counts; single-player reads index 0/4/8. Ultimate is −50 to Fire/Cold/Lightning/Pierce/Acid, −25 to Aether/Chaos/Vitality/Bleeding, and **0 to Physical**; Elite penalises only the first five. The in-game "−25%/−50% to all resistances" blurb is a simplification — do not hardcode it. Read via `GameDb.difficultyPenalty`.
- **Armour is localized, and absorption is multiplicative.** Every physical hit rolls one body part — Head 12%, Shoulders 12%, Chest 24%, Hands 16%, Legs 20%, Feet 16% — and is met by *that piece alone*, so summing the six ratings describes a character who does not exist and hides the weak slot. Flat `+Armor` (`defensiveBonusProtection`, and `defensiveProtection` from anything that is not itself an armour piece — rings, components, skills) is added to **every** part. `defensiveProtection` is therefore context-dependent: a piece's own rating on armour, a character-wide bonus everywhere else. Absorption is `base × (1 + modifier)` capped at 100 — 70 × 1.2 = **84%, not 90%** — with the base in `records/game/gameengine.dbr` (`armorDefensiveAbsorption = 70`; the `records/ingameui/` record of the same name carries a stale 66, ignore it). Hit weights are engine-side, not in the data.
- **Negative `defensive<Type>` is always resistance *reduction*, never player defence.** Verified across every player passive and modifier in the game: zero counter-examples. Skill/modifier banding leans on this, which is what makes the parent-lookup heuristic safe (there is no parent pointer in the data — not on the record, not in `_classtree_classNN.dbr`, not in `records/ui/skills/`; stem numbering `veilofshadows2` → `veilofshadows1` is the fallback).
- **Toggled auras and shouts are two records**: a thin activator holding only `buffSkillName`, and the buff that carries every stat *and the display name and max level*. Always follow the hop for stats **and** for naming — `bonechillingcry1.dbr` has neither a name nor a `skillMaxLevel` of its own.
- **Attribute requirements are equation-derived, not stored.** Every item's `strengthRequirement`/`dexterityRequirement`/`intelligenceRequirement` is 0 (one quest item excepted — non-zero is an override). The real values are equation strings in the 13 `records/game/itemcostformulas*.dbr` records (`itemCostName` on the item picks the file; the item's `Class` picks the `chest`/`axe`/`amulet`… key), evaluated at `itemLevel` by `src/core/db/formula.ts`. Naming: strength=Physique, dexterity=Cunning, intelligence=Spirit. Spears ride the `melee2h` equations (no spear keys are populated anywhere); medals genuinely require nothing. Only ring/amulet equations use `totalAttCount` — and its stat count must be whitelisted to `character*/offensive*/defensive*/retaliation*/augment*/skill*` keys, because counting metadata like `itemLevel` inflates a ring's Spirit requirement (~3% of `itemLevel × 3` per phantom key; this bug shipped and the wearing-it gate caught it). **Level requirements are the opposite: always the explicit field** (never `itemLevel`, 516 records differ), and affixes gate too — effective level = `max(base, prefix, suffix)`.
- **`-% Requirement` reductions are a scope × attribute matrix, and the save's attributes are base-only.** Reduction fields are `character<Scope><Attr>ReqReduction` (Global/Armor/Jewelry/Shield/Weapon/Melee/Hunting; additive, Global stacks on scope; `characterLevelReqReduction` is flat levels) — skip zero values, fifteen medals carry the field zeroed. The character's real attributes = save base + mastery-bar cumulative per-rank arrays (`_classtraining_class{NN}.dbr`) + gear/skill `characterStrength`-family flats, × (1 + %). `checkRequirements` reports rather than filters: a reduction or +attribute can come from the very item a swap removes, and post-swap reasoning belongs to the advisor.
- **Pet skill subtrees (`records/skills/*/pets/`) are four fifths of the skill data** and are out of scope; indexing them takes `db.json` from 21 MB to 66 MB. Keep them excluded.
- `claude` CLI invocation: pipe the context doc via **stdin**, use `-p --output-format json --tools "" --no-session-persistence`, cwd = tmpdir, 180s timeout. Never use `--bare` (it disables the subscription OAuth this tool depends on).

## Verification commands

```bash
npm test                                  # vitest suite
npm run typecheck                         # tsc --noEmit
npm run cli -- parse  <path>/player.gdc   # stage 1: checksums + character summary
npm run cli -- stash                      # stage 2
npm run cli -- db --stats                 # stage 3: build/inspect the item DB
npm run cli -- resolve --char _Suchka     # stage 3: resolution coverage report
npm run cli -- icon --check-all           # stage 4: icon coverage for both characters
npm run cli -- aggregates --char _Suchka  # stage 5A: resistance matrix + damage profile
npm run cli -- context --char _Suchka     # stage 5B: the LLM context doc
npm run cli -- advise --char _Suchka      # stage 6: live AI recommendations
npm run dev                               # stage 7: Electron window
```
