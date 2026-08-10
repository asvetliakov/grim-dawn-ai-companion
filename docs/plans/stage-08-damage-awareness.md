# Stage 8 — Damage awareness: RR fixes, rank tables, and a tool-computed projection

## Goal

The tool analyses resistances thoughtfully and damage barely at all. A live gpt-5.6 run
honestly refused to project attack/attack speed because gear `+skills` move skill ranks —
arithmetic over per-rank DBR arrays the model cannot do. This stage closes that in two
halves:

- **A — data + context document.** Capture every resist-reduction form the aggregate
  currently drops, give the model per-skill damage tables at current effective rank ±4–5
  (so a candidate's `+N to <skill>` can be read off a column instead of guessed), state the
  build focus by magnitude, and put the damage-loss tolerance rule in the prompt.
- **B — computed before→after projection + UI.** `aggregateCharacter(save, db, difficulty)`
  is a pure function of the save, so the tool applies the plan's verdicts to a save copy,
  re-aggregates, and diffs: resistances, speeds, damage per type, moved skill ranks. The
  model stops being asked to write numbers it cannot derive; the UI's "after" columns
  prefer the computed figures (model-authored ones remain the fallback for old envelopes).

Boundaries settled up front: **no DPS number** (RUNBOOK's non-goal — stats at rank and
per-type pools only), hotbar/block-12 parsing **deferred** (the default-attack-replacer
proxy suffices), and the resist cross-check is display-only (no new `PlanWarningKind`,
which would trigger paid repair calls).

## Plan

The full approved plan (verdict-by-verdict mutation table, schema sketches, test lists)
is the working spec for this stage; the summary here is what the Outcome below should be
read against.

- **A1** `stats.ts`: `ResistReductionRow` (category `percent | flat | percentReduced |
  other`, scope, duration/chance, rank/record provenance) + one shared
  `collectResistReduction` covering the `offensive(Total|Elemental|Physical)
  ResistanceReduction(Absolute|Percent)Min` families with their `DurationMin`/`Chance`
  siblings, slow/fumble, and **negative** `defensive<Type>`/`Elemental`/`All` (58+32
  skills produced no RR rows at all). `RR_FIELDS` retired.
- **A2** `aggregate.ts`: collector used from `fold()`, `collectRR()` and the attack
  branch (on-hit RR was silently lost); `SkillDamage` gains `record` and `ownPercent`
  (the skill's own `+%`, discarded before — per-skill scoped, never folded globally).
- **A3** `statfmt.ts`: negative `defensiveAllResistance`/`defensiveElementalResistance`
  render as enemy-RR wording (was `+-25% to All Resistances`); the RR families move to
  `QUALIFIED_EFFECTS` so durations/chances fold in and nothing falls through to raw
  fallback.
- **A4** `builder.ts`: §4 RR block grouped by stacking category (community taxonomy,
  attributed); `### rank-by-rank` tables per attack/RR skill (capped ~10, ranks
  effective−4…effective+5 clamped to ultimate, effective column bolded); devotion
  static note; magnitude-weighted build focus (+1043% Pierce with +150% Cold is one
  specialization and a minor line); §11 damage bullet stays qualitative and gains the
  tolerance sentence.
- **A5** `prompt.ts`: focus-by-magnitude, off-focus utility (CC/mobility/RR earn slots),
  RR stacking + "near max rank" convention, tolerance sentence.
- **B1** `envelope.ts`: `planProjectionSchema` (resistances/speeds/damage/skillRanks/
  skipped/notes), optional on the envelope — old files keep validating.
- **B2** `project.ts` (new): `projectPlan` — structuredClone the save, apply verdicts +
  `fits` (EQUIP replaces the slot instance found via `ResolvedItem.position`; component/
  augment installs rewrite `relicName`/`augmentName`; CRAFT and unknowns degrade to
  `skipped`, never throw), re-aggregate, diff. Skill ranks move for free through
  `effectiveRanks`.
- **B3** wired in `src/main/advise.ts` and the CLI advise handler; **B4/B5**
  `UiStats.damage` + a StatsPanel Damage table mirroring the resist table, after-columns
  preferring computed values; **B6** fixtures/stories/app-check; **B7** tests
  (`test/project.test.ts` headline case: an EQUIP carrying `+1 to <skill>` shifts the
  rank and the skill-derived numbers).

## Verification

- `npm test`, `npm run typecheck` after each half.
- A: `cli aggregates --char _Suchka` (categorized RR incl. previously invisible rows);
  `cli context --char _Suchka` (rank tables clamped at a capped skill, no `+-`, no raw
  RR fallbacks, token estimate +2–3k).
- B: mock `advise --json` carries `.projection`; stories + `stories:check`;
  `env -u ELECTRON_RUN_AS_NODE npm run app:check`.

## Outcome

Both halves landed in one session; 443 tests (+10), 32 story screenshots re-shot, all
story and app checks green. What the verification actually showed: `_Suchka`'s §4 now
carries eight rank tables (Onslaught, Night's Chill, Whirling Death, Open Wounds,
Bonechilling Cry, Leap, Bloodfangs, Fault Line — one more named as omitted past the
cap), the RR list gained the eight `percent`-category rows that previously did not
exist anywhere, and the mock end-to-end run produced an envelope whose projection
cross-check correctly called out the canned answer's invented resistance numbers
("the model projected Fire Resistance at 82; the computed figure is 74").

Deviations from the plan, all recorded because the code is now the authority:

- **Negative `defensive*` reads as RR only off skill and devotion stat blocks.** The
  plan had the fold collector catching "negative defensives on gear" too; that is
  wrong — on an item a negative resistance is the item's own drawback (Voidheart's
  -25% Aether), not a debuff it applies. `CollectRROptions.negativeDefensiveIsRR`
  makes the reading explicit at each call site. (An item drawback still vanishes from
  the matrix — pre-existing behaviour, deliberately untouched here.)
- **The sign fix reached one more family than planned:** secondary resistances.
  `Haunt` (granted skill) was rendering `+-8% Life Leech Resistance`; negative
  secondaries now read `-8% Enemy Life Leech Resistance`.
- **`SkillDamage` gained `ownTotalPercent`** beside `ownPercent` — transmuters
  routinely write `-10% Total Damage` scoped to their skill, and the rank tables
  print it as `+% Total Damage (this skill only)`.
- **The rank tables joined the trim ladder** (`dropRankTables`, last resort, with a
  line saying so) — and the 30k tighten-on-demand test still had to move to **32k**,
  because §4's untrimmable core (RR categories, weighted focus, task guidance) grew
  past the old floor on its own.
- **`AdviseHost` needed no new seam:** the runner reaches the database through
  `scope.input.db`, so the projection wires into `execute()` with what was already
  in scope; the CLI's `contextFor` returns its `CharacterSnapshot` for the same
  purpose.
- The CLI prints a one-line projection summary after a run (damage types, moved
  ranks, skipped verdicts) so a terminal run shows the computed half without
  opening the JSON.
- One transient full-suite failure was observed immediately after `app:check` while
  the Storybook dev server was still up (timing-sensitive runner test under load);
  four subsequent full runs were green and it did not reproduce.
