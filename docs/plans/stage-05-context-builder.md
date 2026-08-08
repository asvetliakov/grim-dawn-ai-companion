# Stage 5B — Context document builder

> Depends on Stage 5A (mechanics layer): the resistance matrix, damage profile, skill/devotion/set/affix data all come from there. This stage renders; it does not compute game mechanics.

## Goal

Compile everything the tool knows into a single markdown "context document" sized for an LLM (~≤30k tokens), via CLI `context --char <name> [--difficulty N]`. This document *is* the AI prompt payload (Stage 6) and a debuggable artifact in its own right.

The design bar: **the advisor must be able to reason holistically from this document alone.** Concretely, all of these must be answerable from the doc without outside knowledge: "if I equip these legs, which augments become redundant and what do I re-slot?", "is +50% pierce damage worth more than +10% chaos res *for this build*?", "which resistance holes are real once buffs are counted, and which totals are fragile because they lean on a duration buff?". The model's own memory of Grim Dawn may predate v1.3/Fangs of Asterkarn — every rule it needs must be stated in the doc.

Format choice is **markdown, not JSON**: human-form stat lines cost fewer tokens than raw key/value JSON and the doc doubles as something the user can read (`npm run cli -- context > doc.md`).

## Document sections (in order)

1. **Header** — name, level, class combo (from the save's `tagSkillClassName*` tag, e.g. "Blademaster"; fall back to the two mastery names), difficulty (from save block 1; `--difficulty`/settings override wins), hardcore flag, iron, game version.
2. **Game rules** (static, self-contained — do not rely on model memory): resistance cap 80 (hard cap 95 via +max-resist), difficulty penalty Normal/Veteran 0 / Elite −25 / Ultimate −50 applied *before* the cap (capped on Ultimate = 130 raw), recommended overcap +20–30 on primary resists against enemy resist reduction, faction market tiers and thresholds, "augments are consumables bought with iron and freely re-appliable — treat every augment slot as a free variable", "components are removable/replaceable; blueprints craft them".
3. **Attributes & defenses** — physique/cunning/spirit (+ unspent points), health, energy, OA/DA, the 5A defense summary (armor total, shield block, sustain); then the **resistance matrix** from Stage 5A verbatim in table form: one row per source (each equipped slot split into base/affix/component/augment contributions, set bonuses, each counted skill/devotion node), the three summary bands (permanent / +maintainable / effective vs cap at this difficulty), the exclusions list, and per-resistance overcap or shortfall numbers.
4. **Skills, devotion & build profile** — mastery point split, unspent skill and devotion points; each skill with ≥1 point: name, rank shown as invested + gear bonus = effective ("12 +4 = 16/22"), one stat line evaluated **at the effective rank** (damage or buff essentials — this is what the skill actually does right now), weapon requirement when restricted ("requires: two-handed melee"), transmuters and modifiers attached to it; devotion constellations with their passive stats, celestial powers and what each is bound to (`autoCastSkill` bindings); then the **damage profile**: ranked damage types with summed % modifiers, flat damage sources, resist-reduction sources. End with one computed sentence: "Build focus: <top-2 damage types>."
5. **Equipped** — one compact block per slot: **item ID** (see below), display name, rarity, level + attribute requirements, set membership ("Deathmarked, 2/4 equipped"), base stat lines, affix stat lines (marked as base roll ± jitter), component (+ completion state and rolled completion bonus), granted skill if any ("Grants: Mutilate"), augment (name + faction + cost). Explicitly call out empty component sockets and missing augments — prime recommendations. Both weapon sets, active one marked; advise for the active set, treat the other as candidates.
6. **Set status** — for each set with ≥1 piece equipped or owned: pieces equipped/owned/missing, active bonus now, bonus at next piece count (so "complete the set" is a visible move; so is "breaking this set loses X").
7. **Candidates** — inventory + personal stash + transfer stash, grouped by equip slot, each with its **item ID** and tagged `[inv]`/`[stash]`/`[transfer]`, with base *and affix* stat lines and attribute requirements. Filtered (below).
8. **Socketables & crafting materials on hand** — components (with completion state) and augments sitting in bags/stash, each with its allowed-slot classes (free moves the advisor should use); plus counts of notable crafting materials (Awakening Ashes and the other `crafting/materials/` items) so upgrade affordability is checkable.
9. **Available faction augments** — per faction the character has unlocked: only tiers actually reached, only level-appropriate augments; name, one stat line, **use-on restriction**, iron cost. Note current iron on hand (header) makes affordability checkable.
10. **Blueprints & upgrade paths** — learned (formulas.gst) relic/gear/component recipes within level range, each with reagent requirements and a computed **craftable-now** flag (checked against materials on hand + iron; if not, list what's missing); purchasable faction blueprints at reached tiers, marked "purchasable at <faction>"; and for any equipped or candidate item whose record is the `baseReagent` of an awakening recipe, a note: "Awakened version exists — requires 12× Awakening Ashes + …" (a strong HOLD signal even when currently unaffordable). State the game rule that ascension (random ascended affix) exists, is expensive, and is a gamble — the advisor may mention it, never prescribe rerolling.
11. **Task** — the instruction block (kept in sync with the Stage 6 system prompt, which carries the full procedure): recommend per-slot **KEEP / EQUIP <candidate> / RE-AUGMENT <name> / ADD-COMPONENT <name> / BUY-AUGMENT <name> / CRAFT <blueprint>**, a HOLD list, a SELL/SALVAGE list; optimize the loadout *as a whole* (gear + component + augment assignment together), not slot-by-slot in isolation; state reasoning; finish with a projected resistance table after all recommended changes.

**Item IDs.** Every item the advisor may reference (equipped, candidates, socketables) gets a short stable ID printed with it (`#a3f`), derived from `(record, seed)` with a location disambiguator for true duplicates. Names are ambiguous — two rings can share an identical name — and Stage 6's structured output plus Stage 7's UI highlighting both key on these IDs. `ResolvedItem` carries the ID so the renderer and the UI derive it identically.

## Filtering heuristics (`filters.ts`)

- Candidates: equippable gear only; level req ≤ charLevel and ≥ charLevel − 25; drop Common rarity when charLevel > 30 **unless** its affixes cover a current resistance shortfall (a yellow with the right resist suffix can be the correct answer); cap ~8 per slot ranked by a relevance score: covers-a-shortfall > matches top-2 damage types > rarity > level proximity.
- Soft class-relevance: don't hard-filter weapon types (GD builds are weird); when over token budget drop caster off-hands for pure-melee mastery pairs and vice versa.
- Token gate: `estimateTokens(doc) ≈ chars / 3.6`; if > 30k, progressively tighten candidate caps (8→5→3), then compress section 10 to counts, then drop section 8's partial components — never touch the matrix, skills, or equipped sections.

## Stat formatting (`statfmt.ts`)

Map the most common DBR stat keys to templates: `defensiveFire` → `+{v}% Fire Resistance`, `characterOffensiveAbility` → `+{v} Offensive Ability`, `offensiveChaosModifier` → `+{v}% Chaos Damage`, min/max pairs → `{min}–{max} Fire Damage`, `…Chance` variants → `{c}% chance of …`, conversion keys, retaliation keys, racial-damage keys. The **skill-reference families** render via the 5A name map, never as raw paths: `augmentSkillName{i}/Level{i}` → `+{n} to {skill}`, `augmentMasteryName{i}/Level{i}` → `+{n} to all skills in {mastery}`, `augmentAllLevel` → `+{n} to all skills`, `itemSkillName` → `Grants: {skill}`, and `modifiedSkillName{i}`+`modifierSkillName{i}` → `Modifies: {skill}` — expanded with the modifier record's notable stat lines **when the character has points in the modified skill** (that's how an awakened item's or ascended affix's real value shows), collapsed to the name otherwise. Build the table by scanning distinct keys actually present for the items/skills in our saves rather than guessing. **Unknown keys fall back to `` `key: value` ``** — never silently drop a stat. Know the flat-vs-% semantics: `defensive*` resist keys are %, `character*` mostly flat, `*Modifier` suffix means %.

## Deliverables

```
src/core/context/builder.ts   # buildContextDoc(resolved, aggregates, db, opts): { markdown; tokenEstimate }
src/core/context/filters.ts
src/core/context/statfmt.ts
src/cli/index.ts              # add `context --char <name> [--difficulty N] [--out file.md]`
test/context.test.ts
```

## Acceptance criteria

1. `npm run cli -- context --char _Suchka` emits well-formed markdown with all 11 sections; token estimate printed and ≤ 30k.
2. The resistance matrix in the doc matches `aggregates --char _Suchka` exactly (same numbers, one renderer test asserts this).
3. Section 9 lists **only** factions/tiers the save's rep values actually reach (unit test at exact threshold boundaries: 1500 vs 1501), each augment with a use-on restriction.
4. Difficulty: auto-detected value shown; `--difficulty elite` (names and 0/1/2 accepted) overrides and is reflected in header, matrix cap math, and task section.
5. Equipped stat lines are human-readable — spot-check 2–3 equipped items of _Suchka against grimtools item pages, *including one affix's stats on a magical/rare item*; no equipped item renders only raw `key: value` fallbacks.
6. Empty component sockets / missing augments on equipped gear are explicitly called out.
7. The self-containment test: hand the doc (not the game) to a person or model and have them answer the three questions in the Goal — each answerable from the doc text alone.
8. `npm test` + `npm run typecheck` green.

## Verification

```bash
npm test && npm run typecheck
npm run cli -- context --char _Suchka --out /tmp/ctx.md && open /tmp/ctx.md   # read it: would a build advisor have what they need?
npm run cli -- context --char _Suchka --difficulty ultimate | head -30        # cap math shifts by 50
```
