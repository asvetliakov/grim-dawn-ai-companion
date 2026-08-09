# Stage 6C — Throughput, stable ids, and a structured answer

Follow-on from the user's review of Stage 6B's live runs. Four things, in the
order they were raised:

1. **The dossier has no speed figures at all.** The advice said, verbatim:
   *"Attack speed drops 5% (Bloodmoon). The dossier gives no attack-speed total,
   so I cannot say whether you were at the 200% engine cap."* This is the one gap
   from both runs' self-reported limitations that Stage 6B did not close, and it
   is already on the RUNBOOK backlog twice. Attack speed is a **throughput
   multiplier on the entire §4 damage profile**, so a dossier that ranks damage
   and omits speed ranks half the answer.
2. **The structured plan is not the UI contract it claims to be.** Stage 7 paints
   the equipment grid from it, and today it cannot: `gains`/`costs` exist in the
   schema but `verdictRows` drops them, so `+12% Fire Resistance` reaches the
   prose and not the table.
3. **Socketables are referenced by name, items by id.** `verify.ts` carries
   `normalizeName` + `nameWithoutQualifier` to paper over it.
4. **`advise` has no machine-readable output** — the answer is markdown on
   stdout, and Stage 7 would have to re-parse it.

---

## Format facts (verified against the installed 1.3.0.6 data this session)

### Attack speed is attacks-per-second, additive, weapon-borne

- `records/creatures/pc/malepc01.dbr` (and `femalepc01.dbr`, identical) —
  `characterAttackSpeed = 1.25`, `characterSpellCastSpeed = 1.25`,
  `characterRunSpeed = 0.93`. These are the **baselines**.
- A weapon's `characterBaseAttackSpeed` is an **additive delta in attacks per
  second**, not a percentage and not a multiplier: Very Fast ≈ −0.02, Fast ≈
  −0.06, Average ≈ −0.10, Slow ≈ −0.15, Very Slow ≈ −0.20. Observed range
  −0.24 … +0.01 (one sword outlier at +0.40).
  **So `1.99` on a weapon is not "199% attack speed"** — it is the
  `tagAttackSpeed = {^W}{%.2f0} {^S}Attacks per Second` display, i.e.
  `(1.25 + delta) × (1 + modifiers)`.
- **Only weapons carry it.** Checked every `Weapon*`/`Armor*`/`ItemEnchantment`/
  `ItemArtifact`/`ItemRelic`/`LootRandomizer` class: `characterSpellCastSpeed`,
  `characterRunSpeed` and `characterAttackSpeed` are zero on all of them, and
  non-zero `characterBaseAttackSpeed` appears on 12 weapon classes and nothing
  else. Shields and off-hands carry the *tag* (`CharacterAttackSpeedAverage`) as
  template filler with no number.
- The character sheet's percentage is that rate **relative to the 1.25
  baseline**, clamped to `[playerAttackSpeedCapMin, playerAttackSpeedCapMax]` =
  `[20, 200]`. This is what the game's own tooltip means by
  `tagCharStatsAttackSpeedDescription` — *"Your weapon attack speed relative to
  the baseline (Includes Total Speed). **Slower weapons gain less from % Attack
  Speed bonuses.**"* A Very Slow weapon needs ~+148% to reach the cap where a
  Very Fast one needs ~+102%.
- `gameengine.dbr` also holds `dwWeaponSpeedFactor = 0.5` (against
  `dwWeaponDamageFactor = 1` and `2hWeaponDamageFactor = 1`). Dual wield weights
  each weapon's base at ½, i.e. the mean of the two deltas.
- Modifier fields: `characterAttackSpeedModifier`,
  `characterSpellCastSpeedModifier`, `characterRunSpeedModifier`,
  `characterTotalSpeedModifier` (all three at once), plus the cap-raising
  `characterAttackSpeedMaxModifier` / `characterRunSpeedMaxModifier`.
  `absoluteRunSpeedCapMax = 350` bounds the raised movement cap.
- Banding matters: `_Suchka` carries Bloodfrenzy's +16% Attack Speed
  (permanent), Veil of Shadow's −12% Total Speed (permanent toggle) **and**
  Pneumatic Burst's +5% Total Speed (maintainable). A single number would be
  wrong in both directions.

### Cunning and Spirit scale damage; the rate is engine-side

The game says which, in its own words:

- `tagCharAttributeDescription01` (Cunning) — *"increasing **physical, pierce,
  bleed and internal trauma** damage. Cunning also increases your capacity for
  pain, your chances of landing melee and ranged attacks, and critically hitting
  enemies."*
- `tagCharAttributeDescription03` (Spirit) — *"increases the flow of energy …
  and **magnifies the damage of magical attacks**."*
- `tagCharAttributeDescription02` (Physique) — heavier gear, dodge, health,
  regen, crit avoidance. **No damage.**
- Confirmed from the other side: `tagCharStatsPhysicalPercentDmgInfo` and its
  Pierce / Bleed / Internal Trauma siblings all read *"not including the bonus
  from Cunning"*, so the char sheet's `+% damage` figure and the attribute bonus
  are separate terms.

**The rate is not in the data.** No DBR field carries an attribute→damage
coefficient — same situation as the armour hit weights. So the dossier names the
scaling and says plainly that the size is not derivable, rather than inventing a
number. Paired with the rule the user asked for: a swap moving Cunning by tens
of points against a total in the hundreds is not a damage argument.

> Note: `tagCharAttributeIncrement01` says *"Each point increases Cunning by
> 10"*, which contradicts `playerlevels.dbr`'s `dexterityIncrement = 8` and the
> game's own `tagTutorialTip15TextB` (*"by 8 per point"*). The record wins, as
> Stage 6B already established; the string is stale. Do not "fix" the code to 10.

---

## Deliverables

### Part 1 — speed in the aggregate and the dossier

- `GameDb.baseSpeeds()` → `{ attack: 1.25, cast: 1.25, run: 0.93,
  dualWieldFactor: 0.5 }`, read from the player creature record and
  `gameengine.dbr`. Schema 10 → 11.
- `stats.ts`: `SpeedFields` + `addSpeed`, accumulated exactly like
  `DefenseFields` (one fold site).
- `aggregate.speed: SpeedSummary` — per kind (attack / cast / movement): the
  weapon-derived base rate, permanent and maintainable modifier percentages, the
  resulting char-sheet percentage and rate before and after the cap, and the
  headroom in modifier points. Plus the per-weapon base rates and their tags.
- §3 gains a **Speed** block: the table, the baseline, the cap, the headroom,
  and one sentence of the model so the advisor can price a `+8% Attack Speed`
  affix instead of guessing.
- §3 gains the attribute-scaling note (which types, no rate, don't block a swap
  over a small delta).
- §2 gains the attack-speed rule, alongside the existing speed-cap line.
- `aggregates` CLI prints it.

### Part 2 — every reference is `id` + `name`

- Components and augments in §8 and §9 get dossier ids, minted from the record
  path with the same FNV-1a/base-36 scheme and de-duplicated against the item
  ids already in use. `ContextDoc` exports `socketablesById`.
- Plan verdicts carry `targetId` **and** `targetName`; `itemName` echoes
  `itemId`. Ids stay the key; names stay for the model and the reader.
- `verify.ts` resolves socketables by id first, name second (an older answer
  still validates), and gains `name-mismatch` when a pair disagrees.

### Part 3 — the plan is the whole answer

Schema gains what only the prose carried: `summary`, `keyMoves[]`,
`projection` (resistances, speeds, notes). `verdictRows` surfaces
`gains`/`costs`.

### Part 4 — `advise --json <file>`

One envelope: `{ meta, usage, warnings, answer, plan }`. The markdown answer
stays the model's own — it is where the reasoning happens and it is the human
product; the JSON is the UI contract beside it, not a replacement.

---

## Acceptance criteria

1. `npm run cli -- aggregates --char _Suchka` prints attack/cast/movement speed
   with the cap and headroom, and the attack figure is a plausible
   attacks-per-second value for a dual-wielding character.
2. §3 shows the speed table; the document still passes its own `ambiguous-stat`
   detector.
3. No number already in §3/§4 changes — speed is additive information.
4. Every component and augment in §8/§9 prints an id; no id collides with an
   item id.
5. The CLI verdict table shows gains and costs.
6. `advise --json` writes an envelope that round-trips through
   `advisorPlanSchema`.
7. `npm test` and `npm run typecheck` clean.

---

## Outcome

All four parts landed. 282 tests pass (269 before), typecheck clean.

### Part 1 — speed

`GameDb.baseSpeeds()` (schema 11) reads `characterAttackSpeed`/`SpellCastSpeed`/
`RunSpeed` from `records/creatures/pc/malepc01.dbr` and `dwWeaponSpeedFactor`
from the engine record. `WANTED_PREFIXES` had to gain the player creature record
— only `playerlevels.dbr` was being decompressed out of that folder, so the
first build returned the defaults and looked correct, which is exactly the kind
of silent fallback that would have shipped.

`stats.ts` gained `SpeedFields`/`addSpeed` (six fields, including the cap-raising
`characterAttackSpeedMaxModifier` / `characterRunSpeedMaxModifier`), folded in at
the single existing site and banded permanent / maintainable.
`aggregate.speed` resolves three `SpeedLine`s end to end.

`_Suchka`, live:

```
Main hand  Servitor's Slicer — Very Fast, base 1.21/s (delta -0.04)
Off hand   Bloodborn Sabre   — Very Fast, base 1.21/s (delta -0.04)
Attack     177% (2.21) → 182% (2.27) buffed  [base 1.21, +83% +5% maintainable]  19pp headroom
Casting    126% (1.57) → 131% (1.64) buffed  [base 1.25, +26% +5% maintainable]  69pp headroom
Movement   138% (1.28)                       [base 0.93, +48% +5% maintainable]  ⚠ 15pp past the 138% cap
```

Two findings that only appear once the number exists: **19 points of attack-speed
headroom** (so a `+8% Attack Speed` affix is still worth something, and 20 points
of it would not be), and **movement is already 15 points past its cap** — which
the character raised from 135 to 138 with `characterRunSpeedMaxModifier`, so
even the cap is not the constant it looks like.

**Deviation from the plan's framing:** the plan implied the composition was
documented. It is not — the caps and both baselines are records, but *how* the
weapon delta, the modifiers and the cap combine is engine behaviour. The rule
is inferred from `tagCharStatsAttackSpeedDescription` ("your weapon attack speed
relative to the baseline … slower weapons gain less from % Attack Speed
bonuses"), which only holds if the weapon term is inside the percentage and the
cap applies to the result. §3 says so in the document rather than presenting the
figures as quoted, on the same principle as the armour hit weights.

### Part 2 — ids

`shortHash` lifted out of `itemId`, so socketables get ids from the same
alphabet and width — a reader cannot tell from an id's shape what it points at.
194 components and augments now carry one, reserved against the 196 item ids.
`verify.ts` resolves by id first and gained `name-mismatch`, which catches the
failure an id-only plan hides: a right name paired with a wrong id, where both
halves of the answer look internally consistent.

### Parts 3 and 4

Schema gained `summary`, `keyMoves[]`, `projected` (speeds + `notDerivable`),
`itemName`/`targetId`/`targetName` per verdict. `verdictRows` now carries
`gains`/`costs` and splits id from name. `advise --json` writes one envelope.

**Mid-stage change, from the user's question about splitting the call in two.**
Measured rather than assumed: the JSON block is ~10k chars ≈ 2.7k output tokens
of a ~30k-token answer, about **$0.20 of a $3.70 run**. A separate extraction
call costs more on Opus (paying the prose back as input) and saves ~4% on
Sonnet — while losing the one thing the plan block exists for, since an
extractor without the dossier cannot resolve ids. Rejected.

The duplication *inside* the single call was real, though: the model wrote a
per-slot table and the CLI rendered its own from the plan, so the terminal
printed it twice. The prompt now forbids the prose table outright — the tool
owns that rendering — and `-o/--out` appends the rendered one so a saved answer
is still complete on its own. Net effect is fewer output tokens and one copy of
the verdicts instead of two that could disagree.

### Live verification

One run on `_Suchka`, Ultimate, opus/effort high. Dossier 195,846 chars /
~54,402 tokens (up from 51,908 — the speed block, the attribute note and 194
socketable ids). First call raised **5 warnings**; one revision → **clean on
every check**. 2 calls · 213,190 in · 76,788 out · **$4.1597** · 845.5 s.

Structured completeness: 18 verdicts, **18/18** with `itemName`, **16/18** with
`targetId`, **16/18** with `gains` (the two without are the KEEPs, which the
prompt exempts), 3 `keyMoves`, a `summary`, and a `projected` block with three
honestly-named `notDerivable` entries.

The speed work paid off exactly where it was aimed. Stage 6's answer said:

> Attack speed drops 5% (Bloodmoon). **The dossier gives no attack-speed total,
> so I cannot say whether you were at the 200% engine cap**; if you were, this
> costs nothing.

This run:

> **Speeds:** Attack **177% → 172%** permanent, **177% with buffs** (cap 200%,
> headroom widens from 19 to 28 modifier points) — **a real ~2.8% throughput
> cost**, the price of the amulet. Casting 126% → 121%. Movement **138%, at
> cap**, unchanged; the 15 points already wasted stay wasted.

It also priced a comparison it previously could not make — Scarmakers' *"+16%
Attack Speed against Silktouch's +8% Attack Speed"* — and listed `-33 Cunning`
among a swap's costs **without** using it to block the swap, which is precisely
the rule §3 states.

**One check was relaxed after the fact.** `name-mismatch` started as string
equality, which is too strict: a display name carries its affixes ("Stealth
Jacket of the Blind Assassin") and a model quoting the base name is being terse,
not wrong. `namesAgree` now tests containment either way. This run happened to
match exactly 18/18, so it would have passed either way — but a false alarm on a
correct plan is the failure mode the `ambiguous-stat` rule already demonstrated
six times, and it was not worth waiting to hit again. The cost is a narrow
weakening (a bare "Band" matches both "Old Band" and "Spare Band"); acceptable,
since these are warnings rather than a gate.

`firstWarnings` was added to the `--json` envelope in the same pass: the terminal
only ever showed the pre-repair count, and the surviving warnings say nothing
about how much repair it took to get there — which is exactly what a run-to-run
comparison needs.
