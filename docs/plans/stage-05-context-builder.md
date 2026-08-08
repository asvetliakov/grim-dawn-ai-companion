# Stage 5 — Context document builder

## Goal

Compile everything the tool knows (resolved character + DB) into a single markdown "context document" sized for an LLM (~≤25k tokens), via CLI `context --char <name> [--difficulty N]`. This document *is* the AI prompt payload (Stage 6) and a debuggable artifact in its own right.

## Context

Available from earlier stages: `resolveCharacter(save, transferStash, formulas, db)` → resolved equipped items, inventory/stash/transfer candidates, faction reps with tiers, learned blueprint paths; `GameDb.vendorItems(factionId, maxTier)` for purchasable augments; settings with `difficultyOverride`.

Format choice is **markdown, not JSON**: human-form stat lines cost fewer tokens than raw key/value JSON and the doc doubles as something the user can read (`npm run cli -- context > doc.md`).

## Document sections (in order)

1. **Header** — name, level, class (derive from the two mastery skill records; map mastery record path → class name, combined pair → canonical combo name if easy, else "Soldier + Demolitionist"), difficulty (from save block 1; `--difficulty`/settings override wins — this is the user's difficulty picker), hardcore flag, iron.
2. **Attributes & defenses** — physique/cunning/spirit, unspent points; a resistance summary computed by **summing resist stats across equipped items + their components + augments only**, explicitly labeled: *"item-sourced only, excludes skills/devotion/set bonuses — treat as a lower bound vs the 80% caps"*. Do not attempt full stat aggregation (reimplementing the engine is a non-goal).
3. **Skills & devotion** — mastery point split, skills with ≥1 point (name via DB tag if resolvable, else record tail), devotion constellations.
4. **Equipped** — one compact block per slot: display name, rarity, level req, stat lines, component + augment (or "empty socket" / "no augment" — the AI should notice those).
5. **Candidates** — inventory + personal stash + transfer stash, grouped by equip slot, each tagged `[inv]`/`[stash]`/`[transfer]`. Filtered (below).
6. **Available faction augments** — per faction the character has unlocked: only tiers actually reached (from rep values), only augments with level req ≤ character level; name + one stat line each.
7. **Blueprints** — learned (from formulas.gst) relic/gear recipes within level range; plus purchasable faction blueprints at reached tiers, marked "purchasable at <faction>".
8. **Task** — the instruction block: for each equipment slot recommend **KEEP / EQUIP <candidate> / BUY-AUGMENT <name> / CRAFT <blueprint>**, plus a **HOLD** list (items worth keeping for later levels/difficulties) and a **SELL/SALVAGE** list; address resistance holes first; give one-line reasoning per recommendation; consider the stated difficulty.

## Filtering heuristics (`filters.ts`)

- Candidates: equippable gear only; level req ≤ charLevel and ≥ charLevel − 25; drop white/yellow rarity when charLevel > 30; cap ~8 per slot preferring rarity then level req.
- Soft class-relevance: don't hard-filter weapon types (GD builds are weird), but when over token budget drop caster off-hands for pure-melee mastery pairs and vice versa.
- Augments: only reached tiers, level-appropriate, name + primary stats only.
- Token gate: `estimateTokens(doc) ≈ chars / 3.6`; if > 25k, progressively tighten candidate caps (8→5→3) then compress section 7 to counts before touching anything else.

## Stat formatting (`statfmt.ts`)

Map the ~100 most common DBR stat keys to templates: `defensiveFire` → `+{v}% Fire Resistance`, `characterOffensiveAbility` → `+{v} Offensive Ability`, `offensiveChaosModifier` → `+{v}% Chaos Damage`, etc. Build the table by scanning distinct keys actually present in the cached dump for the items in our saves (a small script/test can enumerate them) rather than guessing all keys. **Unknown keys fall back to `` `key: value` ``** — never silently drop a stat.

## Deliverables

```
src/core/context/builder.ts   # buildContextDoc(resolved, db, opts): { markdown: string; tokenEstimate: number }
src/core/context/filters.ts
src/core/context/statfmt.ts
src/cli/index.ts              # add `context --char <name> [--difficulty N] [--out file.md]`
test/context.test.ts
```

## Acceptance criteria

1. `npm run cli -- context --char _Suchka` emits well-formed markdown with all 8 sections; token estimate printed and ≤ 25k.
2. Section 6 lists **only** factions/tiers the save's rep values actually reach (unit test with a synthetic save at exact threshold boundaries: 1500 vs 1501 etc.).
3. Difficulty: auto-detected value shown; `--difficulty elite` (accept names and 0/1/2) overrides and is reflected in header + task section.
4. Equipped stat lines are human-readable — spot-check 2–3 equipped items of _Suchka against grimtools.com item pages; no equipped item renders as only raw `key: value` fallbacks.
5. Empty component sockets / missing augments on equipped gear are explicitly called out (they're prime recommendations).
6. `npm test` + `npm run typecheck` green.

## Verification

```bash
npm test && npm run typecheck
npm run cli -- context --char _Suchka --out /tmp/ctx.md && open /tmp/ctx.md   # read it: would a build advisor have what they need?
npm run cli -- context --char _Suchka --difficulty ultimate | head -20
```
