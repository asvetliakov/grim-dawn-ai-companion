# Stage 8B — Projection follow-ups from the first live A/B

## Context

Stage 8 shipped the tool-computed before→after projection, and on 2026-08-10 both live
backends ran the new dossier at medium effort: **opus** ($2.30, 552s) and
**gpt-5.6-sol** (subscription, 307s) — both **clean in one call, zero warnings**, where
every pre-Stage-8 live run had needed a repair. The A/B validated the design (gpt's
independently-derived resistance projection matched the computed one **10/10 exactly**;
the computed attack speed answered the very number gpt declared `notDerivable`) and
surfaced four concrete gaps. This stage closes them, plus one user-requested addition.

The run artifacts backing every finding: `advice/_Suchka/` holds nothing from these runs
(CLI `--json` runs don't persist) — the envelopes were inspected at
`opus.json`/`gpt.json` in the session scratchpad; the facts below are restated
self-containedly so nothing depends on those files surviving.

## Findings → work items

### 1. Slot-label aliases (numeric consequence — fix first)

Opus wrote `Main hand` / `Off hand` where the dossier's labels are
`Weapon set 1 main` / `Weapon set 1 off`. `projectPlan` skipped both verdicts
(`unrecognized slot label`) — and each was a `BUY-AUGMENT` carrying `+10% Chaos
Resistance`, so the computed Chaos came out 69 where the model said 89. The projection
was right *given what it applied* and honest about the skips, but the numbers were
wrong by 20 points because of a vocabulary miss.

- `slotRef` (in `src/core/ai/project.ts`) learns the aliases, resolved against the
  **active** weapon set: `main hand`/`off hand` (and reasonable variants —
  `weapon 1 main`, `mainhand`) → `{kind:'weapon', set: activeSet, hand}`. It needs the
  active set passed in, so the signature grows or the mapping moves inside
  `projectPlan` where `activeSet` is known.
- Hoist the resolver into a shared helper (e.g. beside `EQUIP_SLOT_NAMES` in
  `src/core/save/types.ts`, or exported from `project.ts`) and use it in **every**
  slot-label consumer: the renderer's `loadoutDrift` join and any verdict-to-slot
  lookup. One matcher, not three.
- Prompt (`src/core/ai/prompt.ts`): one sentence — verdict `slot` must repeat §5's
  heading **verbatim** (`Weapon set 1 main`, not `Main hand`). Belt and suspenders.
- No new `PlanWarningKind` — an alias is normalized silently; a genuinely unknown
  label still lands in `skipped`.
- Test: pin the exact opus case — a verdict on `Main hand` applies to
  `weaponSet1[0]` (and to set 2 when `alternateWeaponSetActive`).

### 2. Cross-check band semantics (noise, not error — but also a vocabulary drift)

Opus reported Fire/Cold/Lightning at 80 — deliberately **permanent-band** effective
("Elemental Awakening's +30% becomes a pure overcap buffer instead of a crutch", its
own note) — while `projectedResistances` is defined as effective *with* maintainable.
Three "the model projected X; the computed figure is Y" notes were noise about a
reporting-band choice, not a disagreement. And the drift is visible **inside the
model's own prose table**, which printed `+ maintainable 160` directly above
`effective 80`: it relabelled §3's `effective` row (withMaintainable + penalty) as
permanent + penalty. The philosophy is defensible; the redefinition of a §3 row is
not, because the UI and the checks join on that word.

- `planProjectionSchema.resistances` rows gain `afterPermanent` (permanent-band +
  penalty, computed from the same after-aggregate). Envelope-optional as always.
- The cross-check accepts a model figure that matches **either** band within ±2;
  a note fires only when it matches neither (that note now means something).
- UI: the after cell keeps showing effective; where the two bands differ, the row's
  title/detail may state `…of which +30 maintainable` — small, optional polish.
- Prompt + §11: one sentence pinning the vocabulary — `projectedResistances` and the
  prose table's `effective` row mean §3's definition (withMaintainable + penalty,
  post-penalty); a permanent-only reading belongs in the notes, argued as such, never
  as a silent relabel of the row.
- Test: a model figure equal to `afterPermanent` produces no note; one matching
  neither band still does.

### 3. Rank tables for buffs whose stats move (the Bloodfrenzy gap)

Both models hit the same wall from opposite sides: gpt listed *"exact attack speed
after Bloodfrenzy moves from rank 13 to rank 10"* as notDerivable, and it was right —
the §4 rank tables cover **attack and RR bands only**, and Bloodfrenzy is a permanent
buff whose per-rank `+% Attack Speed` / `+% Pierce & Bleeding Damage` appear nowhere
per-rank. The computed projection covers the consequence; the model should be able to
read the cause.

- Extend `skillRankTables` qualification (`src/core/context/builder.ts`): also include
  invested skills whose `classify` band is `permanent` or `maintainable` **and** whose
  stat record (after the `buffSkillName` hop) carries array-valued stats among: the
  damage `Modifier`/`Min` families, `SPEED_FIELDS`, OA/DA
  (`characterOffensive/DefensiveAbility`), and resistances. Skip buffs whose arrays
  don't move inside the ±5 window.
- **Row labels change meaning by band**: on an attack skill `+% Bleeding Damage` is
  skill-scoped (`(this skill only)`); on a permanent/maintainable buff the same field
  is a **global** character modifier and must be labelled plainly (`+% Bleeding
  Damage`) — printing "(this skill only)" on Bloodfrenzy's rows would be wrong. New
  rows: `+% Attack Speed`, `+% Casting Speed`, `+ Offensive Ability`, resistance
  lines, labelled from the same vocabulary statfmt uses.
- Cap: keep ~12 tables total; priority attack/RR first (they answer damage questions),
  then buffs by invested points; the omitted named, as now. Token cost ~+1–2k; the
  trim ladder's `dropRankTables` already covers the pathological case.
- Test: a maintainable buff with array `characterAttackSpeedModifier` gets a table
  with a `+% Attack Speed` row and no "(this skill only)" wording; live doc gains a
  Bloodfrenzy table (assert its name appears under the rank-tables heading).

### 4. Weapon payload index — the "total damage" figure (user-requested)

The tolerance rule ("~a third of the primary `+%` pool is too much") reasons over one
type at a time; the user wants the overall trade visible. Add a single comparable
scalar: the **weapon payload index** = Σ over types of
`flat[t] × (1 + (percent[t] + totalDamagePercent) / 100)` — the post-conversion flat
pools scaled by their own `+%` columns.

Framing is the whole design: it is an **index in arbitrary units**, not DPS — it
excludes attack speed (stated beside it; §3 carries the rate), crit, and skill
`% Weapon Damage` multipliers, and RUNBOOK's per-skill-DPS non-goal stands. What it is
good for is exactly the user's question: "this plan costs 4% of the payload" vs "this
plan costs 30%".

- `DamageProfile` gains `payloadIndex: number` (computed in `damageProfile()`);
  include the attribute damage bonus per type **if** the rates × group membership are
  already exposed by the mechanics layer (§3's `attributeScaling` computes them —
  reuse, don't duplicate); otherwise exclude and say so in the disclosure line.
- §4: one line after the damage table — the index, its delta arithmetic already
  explained by the existing composition paragraph, and the exclusions named.
- §11 + prompt: the tolerance sentence gains the index as its yardstick ("state the
  index delta; low single digits for a capped resistance is normal, tens of percent
  needs the resistance case spelled out").
- `planProjectionSchema` gains `payload: { before, after }`; UI renders one
  `stats-note` under the Damage table: `payload index 41.2k → 39.5k (−4.1%)`
  (delta-coloured); CLI summary line prints the same.
- `AMBIGUOUS_STAT` check: "payload index 41,200" must not trip the matcher (it is not
  a damage-type name; add an echo test anyway).
- Test: index arithmetic pinned on a synthetic profile; projection carries
  before/after; UI note renders.

### 5. Project the defence block too (retires the models' remaining notDerivable)

Both models hand-computed in prose what the aggregate already knows: opus's notes
carried weakest-part armour, mean, absorption, OA/DA contributions, attribute totals
and requirement re-checks; its `notDerivable` listed OA and health *totals* (engine
base — genuinely not modelled, stays excluded). Give the projection what the aggregate
has:

- `planProjectionSchema` gains an optional `defense` block: armour per weakest part +
  hit-weighted mean + absorption, OA/DA contributions (flat + %), health
  contributions, and attribute totals (physique/cunning/spirit) — all
  before/after, all straight off the two aggregates in `diff()`.
- UI: the existing `Row` `after` prop on the Armour mean/Absorption rows and the
  attribute rows; nothing new to invent.
- Not in scope: engine-base OA/DA/health floors (unmodelled, disclosed — unchanged).

### 6. Projection audit test (correctness, made durable)

The live A/B corroborated the arithmetic (gpt 10/10 exact; opus reconciles once the
skips and band choice are accounted for). Pin that class of correctness:

- A live-save test (`describe.skipIf`, like the others): pick a real bag candidate,
  project a single `EQUIP` via `projectPlan`, and independently hand-mutate the save
  (test code writes `save.equipment[slot]` itself) → `aggregateCharacter` on both;
  assert the after-aggregates agree on resistances, speeds and damage. Different
  mutation code paths agreeing is the point.
- Keep the synthetic suite as-is; add the alias and band cases from items 1–2.

### 7. The prose resistance table goes; the tool appends the computed one

The verdict-table precedent, replayed: the prompt's output bullet still demands a
"Projected resistance table" in the prose, the tool now computes the real one, and two
copies can disagree — today they did (opus's prose table is where its
`+ maintainable 160` / `effective 80` inconsistency lived). The model's **JSON**
`projectedResistances` stays — it is the cross-check's other half and proved its worth
twice in the A/B — but the prose table is rendering, and rendering is the tool's job.

- `prompt.ts`: the output bullet stops asking for the prose table; the model states
  cap outcomes in prose sentences (which is where its reasoning value lives) and
  tallies in the JSON field.
- CLI `advise -o`: append the computed projection table after the verdict table, so a
  saved answer still stands alone (same mechanism, same reason).
- Saves ~200–300 output tokens per run; kills the prose-vs-computed disagreement
  class outright.
- Watch item for the live confirmation run: plan quality must not degrade — the JSON
  tally still forces the capping arithmetic, but if capped-resistance misses reappear,
  restore the prose table and record why.

## Execution order

1 (aliases) → 2 (band semantics) → 4 (payload index) → 5 (defense block) → 7 (prose
table out, appended computed table in — with 2's prompt edits, one prompt pass) → 3
(buff rank tables — last because it's doc-shape work with token-budget interaction) →
6 (audit test) → verification. Items 1+2 change `project.ts`/schema together; ship as
one commit if committing per-item.

## Verification

- `npm test`, `npm run typecheck`.
- `cli context --char _Suchka`: Bloodfrenzy (and other qualifying buffs) present under
  the rank-tables heading, with `+% Attack Speed` rows, without "(this skill only)" on
  global lines; payload index line in §4; token estimate still comfortably under
  budget (expect ~+1–2k).
- Mock `advise --json`: `.projection.payload` and `.projection.defense` present;
  a `Main hand` verdict in a doctored plan projects instead of skipping.
- `stories:check` + `app:check` after the UI rows/notes are added.
- Optional live single run (either backend, medium) to confirm the cross-check notes
  are quiet on a clean plan and the model stops listing buff-rank speeds as
  notDerivable.

## Non-goals (unchanged)

Per-skill DPS (crit, `% Weapon Damage` inheritance folded into one number) stays out —
the payload index is deliberately pre-attack-speed and pre-skill. Hotbar/block-12
parsing stays deferred. The engine's OA/DA/health base stays unmodelled and disclosed.

## Outcome

All seven items landed; 453 tests (+10), 260 story assertions (+8), 43 app assertions
(+2), typecheck clean. Deviations and decisions, per item:

1. **Aliases** — the shared matcher went to **`src/shared/slots.ts`**, not beside
   `EQUIP_SLOT_NAMES`: the renderer needs it as a *value*, and a zero-import module in
   `src/shared/` is the one place both the core and the `types: []` renderer can take
   it from. `slotKey` moved there too (re-exported from `advice.ts` for the
   components). Hand-only aliases (`Main hand`, `mainhand`, `off-hand weapon`) resolve
   against the **held** set; set-numbered forms (`weapon 2 off`) name their set as
   written; bare `main`/`off` stay unrecognized on purpose. Consumers: `projectPlan`'s
   `slotRef` (signature grew `activeSet`, resolved inside `projectPlan`), the
   renderer's `adviceBySlot`, `loadoutDrift`, the verdict table's done-strikethrough
   and its socket-move lookup. Prompt gained the "repeat §5's heading verbatim"
   sentence. Pinned: a `Main hand` `BUY-AUGMENT` applies to `weaponSet1[0]`, and to
   set 2 when `alternateWeaponSetActive`.
2. **Band semantics** — as planned. `afterPermanent` (optional) on every projection
   resistance row; the cross-check notes only a figure matching *neither* band within
   ±2, and the note names both (`the computed figure is 74 (44 permanent-band)`). The
   UI polish is a `title` on the after cell stating the maintainable share. §11 and
   the prompt pin `projectedResistances`/"effective" to §3's definition, permanent-only
   readings to `projected.notes`.
3. **Buff rank tables** — qualification as planned (band `permanent`/`maintainable`
   after the buff hop, a qualifying per-rank array that moves inside the window), but
   the ordering deviates: buffs sort by **gear-granted rank first** (`bonus`, then
   invested), because sorting by invested points dropped Bloodfrenzy — 7 invested
   + 6 from gear — below the cap, and a rank that gear moves is the one the tables
   exist to read. Cap 10 → 12; heading now "Attack, resistance-reduction and
   moving-stat buff skills, rank by rank"; buff tables carry a *(buff — rows are
   global character modifiers while it is up)* note and never "(this skill only)".
   Live doc: Bloodfrenzy with `+% Attack Speed` / `+% Casting Speed` per rank and
   three global `+%` damage rows; 12 tables shown, 11 more named. ~57.3k tokens,
   comfortably under the 100k budget.
4. **Payload index** — `DamageProfile.payloadIndex`, computed in `damageProfile()`
   off the unrounded post-conversion pools. The **attribute damage bonus is
   excluded** (the plan's own fallback): the rates × group membership live in the
   builder's `attributeScaling` prose, not in the mechanics layer, and duplicating
   the group table for an index was not worth it — the §4 line names the exclusion.
   §11 + prompt gained the index-delta yardstick; `projection.payload` before/after;
   UI note (`payload index 41.2k → 39.5k (−4.1%) … an index, not DPS`); CLI prints
   the same line. `_Suchka`'s live index: 7,739. `ambiguousStats` echo test added.
5. **Defense block** — as planned, with one UI restraint: `defense.health` is stored
   (contributions, like §3) but the Health row gets **no after-cell**, because the
   row's headline number is the save total and the engine base is unmodelled — an
   after there would misstate what moved. Attribute rows, armour Mean and Absorption
   carry the after values.
6. **Audit test** — live and green: a real bag candidate EQUIPped via `projectPlan`
   vs. the test hand-writing `save.equipment[slot]` itself, aggregated independently
   — all ten resistances, attack and cast speed, every ranked damage type and the
   payload index agree exactly.
7. **Prose table retired** — the prompt asks for cap-outcome *sentences* plus the
   JSON tally; `advise -o` appends the computed projection table (with a
   permanent-band column where it differs from effective, and the payload/speed/skip
   lines) after the verdict table, so a saved answer still stands alone.

### Live confirmation runs (2026-08-10, both at medium)

**gpt-5.6-sol: 261s (was 307s), 13.4k out (was 15.7k), clean in one call, zero
skips.** The three Bloodfrenzy `notDerivable` entries are gone — the model read the
buff rank tables and *derived* the post-plan attack speed ("attack speed falls from
182% to 175%") it had honestly refused to project pre-8B; what remains in
`notDerivable` is genuinely unmodelled (engine health/OA base, DPS, procs). It used
the payload index unprompted and accurately ("7739 → approximately 7814, a +1.0%
delta" — the tool computed 7,810), wrote no prose resistance table, and stated cap
outcomes in sentences as asked.

**opus: 448s / $2.09 (was 552s / $2.30), one call, zero skips, zero disagreement
notes.** The two `Main hand` / `Off hand` verdicts that pre-8B fell out of the
projection as `unrecognized slot label` are gone twice over — the model now writes
`Weapon set 1 main` verbatim (the prompt sentence) *and* the matcher would resolve
the alias if it relapsed. Its `projectedResistances` matched the computed projection
**10/10 exactly, in the effective band**: the pre-8B run's three
Fire/Cold/Lightning notes were opus relabelling §3's effective row as
permanent-band, and the vocabulary pin ended that — it reported 110 (with the
maintainable +30) and argued the overcap-buffer reading in prose, exactly where it
belongs. It also used the payload index unprompted (+2.1%, matching the tool's
7,739 → 7,901). One surviving warning, `ambiguous-stat` on two prose spellings
("525 Physical", "10% Frostburn") — prose-only, so it is reported and deliberately
buys no repair call.

**The watch item fired once (on gpt), and the safeguard caught it.** The run's one projection
note is real: the model's JSON tally says Acid 100 while its own Medal verdict
lists `-28% Acid Resistance` in `costs` — it dropped its own cost from the tally, and
the computed figure (72, eight short of cap) is what the reader sees in the sheet and
the appended table. Pre-8B this slip would have appeared identically in the prose
table and the JSON (it is an arithmetic error, not a rendering disagreement), so the
prose table stays retired; the cross-check note — which now means something, having
been silenced for band choices — is the surface that caught it.

**It recurred the same day** — the user's own window run (gpt-5.6, medium, one
`illegal-socket` repaired to clean) dropped the identical `-28% Acid Resistance`
cost on the identical medal, tally claiming Acid 100 against a computed 72 — so the
escalation was implemented immediately as **`overstated-cap`**: a resistance the
tally claims at/over `capAfter` while the computed figure lands more than 2 points
under it is a repair-worthy `PlanWarning`. Narrowest possible reading — honest
under-cap figures and band choices still only note, and the check stands down
entirely when the projection skipped any verdict (a partial computed figure is
missing gains the model legitimately counted — the mock pipeline proved this
immediately, tripping the first draft of the check on its own unresolvable ids). It required the projection
*inside* the repair loop: `PlanCheckInput` gained an optional
`project(plan) → PlanProjection` callback (the projection needs the save, account
and database, which the checks have no business holding), and the CLI and the run
manager both wire it to `projectPlan` over the same input the envelope's final
projection uses. The prompt's tally rule also now states that `gains`/`costs` are
part of the sum and the arithmetic is checked mechanically.
