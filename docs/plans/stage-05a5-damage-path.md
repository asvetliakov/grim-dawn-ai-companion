# Stage 5A.5 — Damage-type path: conversion-aware profile & per-skill damage typing

> Follow-on prompted by the user: the advisor must judge **damage-type fit** — never suggest a fire sword to a pierce+bleed build unless it's an explicit trade-off. That needs the character's *post-conversion* damage path, per-skill damage types (incl. the "main attack"), and candidates judged by their damage identity. This promotes the backlog item "conversion-aware damage ranking" and closes four honesty gaps found on the way (armor piercing unmodelled, `Max` flats dropped, attack skills' damage never collected, conversion strings untyped).

## Engine rules (web-verified; encoded in `stats.ts` and stated in 5B §2)

- **Order**: a skill's own conversion (record, modifiers, transmuters) applies first; **global conversion** (equipment & permanent buffs) applies after; `+% damage` modifiers apply last, to the *post-conversion* type. ([steam](https://steamcommunity.com/app/219990/discussions/0/1739968490552137046/))
- **Damage is converted only once** — never chained through a second pair.
- **Same-priority conversions past 100% split the pool proportionally** (100%→fire + 100%→acid = 50/50).
- **DoT twins convert together**: Physical↔Internal Trauma, Fire↔Burn, Cold↔Frostburn, Lightning↔Electrocute, Acid↔Poison, Vitality↔Vitality Decay. Pierce/Aether/Chaos have no twin — the DoT part stays behind, unconverted. **Bleeding never converts** (data-confirmed: no `Bleeding` conversion in/out type exists in any record).
- **Elemental umbrella**: in-type `Elemental` converts fire, cold *and* lightning each at the stated %; out-type emits a ⅓ split; flat Elemental deals ⅓ each; `+% Elemental` boosts all three but not their DoTs.
- **`% Armor Piercing`** (`offensivePierceRatioMin`) deals that share of the weapon's **physical** damage as pierce — physical only ([steam](https://steamcommunity.com/app/219990/discussions/0/1733217528122477244/)), and the ratio is the **base weapon record's own**: all 270 carriers in v1.3.0.6 are weapons — no component, affix, or skill carries the field (the old "+% Armor Piercing" component bonuses left the game; they stacked multiplicatively when they existed).
- **Flat damage on gear applies only to weapon attacks** (default attack + `% Weapon Damage` components of skills), so the post-conversion flat distribution is the *weapon-attack composition*, not "the build's damage".

## Data facts (verified against the schema-8 cache)

- Conversion vocabulary: `Physical, Pierce, Fire, Cold, Lightning, Poison(=Acid), Life(=Vitality), Aether, Chaos, Elemental`, plus `Stun` (dropped — not a tracked damage type) and one semicolon mega-list `Physical;Pierce;…;Stun` on 36 full-convert transmuters. Carriers: items 1,984 / affixes 504 / sets 40 / skills 825 (often per-rank arrays).
- `weaponDamagePct` on 868 skills. Default-attack replacers are class `Skill_WeaponPool_{BasicAttack,ChargedScaling,ChargedFinale}` (Fire Strike, Savagery, Cadence, Onslaught); `Skill_WPAttack_*` are the WPS procs riding them.
- Live proof of the gap: `_Suchka` carries a global **30% Elemental → Pierce** (Chosen Epaulets) the old ranking ignored, and both swords have **100% Armor Piercing** — her real physical flat is zero.

## Deliverables

- `stats.ts`: `Conversion` gains `fromKeys`/`toKeys` (`DamageKey[]`; normalized display names — Vitality/Acid, `All` for the mega-list); `applyConversions()` (once-only, proportional >100%, DoT twins); `DOT_COUNTERPART`; flat damage read as **min–max midpoints** (`offensive*Max`/`offensiveBase*Max` now consumed; `offensiveBonusPhysical{Min,Max}` mapped).
- `aggregate.ts`: conversions carry `scope` (`global` / `global (maintainable)`); armor piercing applied per weapon part in `contributions()` (base record's ratio, both ends moved so midpoints stay exact); permanent global conversions **applied to the flat pools** feeding `damage.ranked`; `damage.weaponAttack` (post-conversion composition shares + named main attack); `damage.skillDamage` (per invested attack skill: rank, `% weapon damage`, own flat types, skill-scoped conversions — modifier/transmuter nodes merged into the skill they modify via the existing parent machinery). Exclusion lines updated (conversion folded; midpoints; gear flats reach skills only via `% weapon damage`).
- CLI `aggregates`: conversion lines with scope, `build path:` line, `Weapon attack:` composition + `main attack:`, per-attack-skill block.
- 5B plan: §2 conversion rule-book replaces the old caveat; §4 renders the damage path; §7 candidates carry a damage-identity line with `off-type` marks; statfmt adds `% Armor Piercing`. Stage 6: step 1 judges fit against the post-conversion path (off-type only as explicit trade-off); acceptance 3 extended.

## Acceptance criteria

1. Unit: conversion typing (Elemental expansion both directions, Life/Poison naming, semicolon list → `All` minus Stun, zero-percent dropped); `applyConversions` (once-only, proportional split, DoT twin taken/left, bleeding untouched); midpoint flats (pair → mean, lone Min → itself, elemental ⅓).
2. Stub aggregate: 100%-armor-piercing weapon deals its base as pierce (physical row gone); a non-weapon part's claimed ratio is ignored; a permanent buff's conversion is `global` and folded at rank; an attack skill's conversion stays on its `skillDamage` row (merged from its transmuter node) and out of the global list; default-attack replacer named; composition shares sum to ~100.
3. Live `_Suchka`: 30% Elemental→Pierce present as `global` and folded (physical flat 0, pierce > 200); composition sums to ~100 led by pierce; >2 attack skills typed; main attack = Onslaught with >100% weapon damage; top-2 stays `pierce, bleeding`.
4. `npm test` + `npm run typecheck` green; before/after diff of `aggregates` shows only intended changes.

## Outcome

Implemented as planned; 70 mechanics tests pass (154 total). Notes:

- The live run made the case for the stage better than the plan did: `_Suchka`'s displayed "+138 flat physical" was never real — both swords are 100% armor piercing, so it was pierce all along; with the Epaulets' conversion folded, pierce flat goes 137 → 318 and the weapon attack reads 57% pierce · 32% bleeding · 10% frostburn. The profile also revealed her main attack (Onslaught r20, 186% weapon damage) — previously invisible because attack skills were skipped wholesale.
- Mid-implementation the user asked whether armor piercing converts only physical — confirmed by search, and the check surfaced a second correction: ArP increases from other sources stack *multiplicatively* on the weapon's base ratio, but no such source exists in current data (all 270 carriers are weapons), so the ratio is read from the base weapon record alone rather than summed across parts as first written.
- `_abcdef` (Forcewave Soldier) reads 57% physical · 43% chaos off a "Demonic" affix's 35% Physical→Chaos — affix-borne global conversion working; the Rending Force modifier merges into Forcewave's row.
- Full %-weapon-damage DPS simulation stays a non-goal; the ranking's sort is still %-modifiers-first (they follow the build's investment and apply post-conversion), with truthful flats as the tiebreak.
