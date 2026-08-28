# Stage 12 — Candidate projections: the tool does the subtraction, the model does the choosing

## Context

The idea on the table was "compute plans mathematically, let the AI judge". The full version
was declined: the scalar objective *is* the judgment (which resistances to leave short, which
damage type to weight, whether a set proc is worth a stat line), and a generator's blind spots
become silent coverage failures — the same shape as the retrieval arm's 14/16 slots
(CLAUDE.md, 2026-08-28). But the instinct is half right, at the *candidate* level rather than
the *plan* level:

- §7 printed every candidate's **absolute** stats and said nothing about the worn item.
  Every "swap this in → Acid drops 28 → under cap → what covers it" was subtraction the model
  performed in reasoning tokens — and wall time is output tokens, ~¾ of them reasoning.
- The evaluator already existed: `projectPlan` clones the save, applies verdicts, re-runs
  `aggregateCharacter` and diffs — *after* the answer. Running it *before*, once per
  candidate, hands the model facts instead of homework.
- Doctrine: `filters.ts` rejected "a scoring function that tried to simulate the swap" as
  doing the advisor's job, and stage‑06b says "the arithmetic belongs in the document, the
  judgement in the advisor". The line held here: **a projection is a fact about one swap,
  printed whole; a score is a ranking.** Projections never feed `score` or candidate order.

Hypothesis, to be **measured, not argued**: reasoning shifts from subtraction to choice →
fewer thinking tokens at equal-or-better slot coverage and warnings. If it doesn't, revert
the document and prompt change (the refactor and the two-hander fix stand on their own).

A second, unrelated gap surfaced while planning and shipped first (Part B): attack damage
converted to health was summed but never explained, attributed, weighed or projected.

## Part B — sustain (`% of Attack Damage converted to Health`)

Already there: `offensiveLifeLeechMin` → `DefenseFields.lifeLeechPercent`, summed by the
aggregate's fold over gear parts, permanent skills and devotions; attack skills never reach
the fold, so a skill-innate figure was correctly *not* global. Five places did not know the
number existed:

1. **§4 attack-skill rows** dropped the skill's own figure — the one case where it applies to
   the skill's *whole* damage. `AttackRow`/`SkillDamage.lifeLeechPercent`, printed as
   `12% of Attack Damage converted to Health *(this skill only, on its whole damage)*`, plus a
   rank-table row.
2. **§3 had no per-source breakdown.** `DefenseSummary.lifeLeechSources` (slot, label,
   value), printed as `sustain: 11.0% of Attack Damage converted to Health (global — §2 says
   what it applies to) — from Hands: Unholy Inscription 5%, Devotion: Fox 6%`. The game's own
   phrase, so the model's vocabulary matches the item lines.
3. **§2 said nothing about how it works.** One paragraph, attributed as community mechanics:
   global ADCTH applies to weapon attacks and the `% Weapon Damage` share of a skill; a
   skill's own to its whole damage; DoTs and retaliation never leech; reduced by the
   *target's* Life Leech Resistance — distinct from the character's own `Life Leech` entry
   in §3's other resistances.
4. **The prompt never weighed it.** Step 3's second defensive layer and step 11 (hardcore)
   name sustain, with the rule for when it is worth something.
5. **The projection did not track it.** `defense.sustain` on `planProjectionSchema`
   (optional — older runs), filled by `project.ts`, shown in the UI's Stats panel beside
   absorption with the projection after-cell, and carried on every candidate line below.

## Part A — candidate projections

### `src/core/ai/project.ts`

`projectVerdicts(verdicts, input, { before? })` is the extracted core, returning the
projection **and** both aggregates; `projectPlan` wraps it and adds the model-disagreement
notes (`noteModelDisagreements`, moved out of `diff`). `before` is passed in by the builder,
so a hundred candidates share one aggregate.

**Two-hander gap closed in the shared path** (it was in `projectPlan` too): an `EQUIP` of a
`/2h$/` class into the main hand nulls the off hand and notes what left; an off-hand `EQUIP`
while a two-hander is held is `skipped` with the reason; a two-hander into the off hand is
refused.

### `src/core/context/projections.ts` (new)

`candidateProjections(candidates, input)` → per candidate, one `SlotProjection` per target
slot: `Ring` → both fingers; a one-hander on a dual-wielder → both hands; `Off hand` → the
held set's off hand; everything else its one slot. Each target carries the `PlanProjection`
(or a `skipped` reason), the outgoing item and anything else cleared, the **departing
socketables** (resist vector; whether the component *refits* the candidate's use-on flag;
the augment's re-buy line from `socketableObtain`), **set piece moves** (distinct members,
counted directly — a set with no resistance bonus has no matrix row), the **equip-time
requirement check** (`checkRequirements` against the aggregate of the save with the target
slot emptied — memoised per slot, ≤ 15 extra aggregates — printed only when it differs from
the as-dressed check), **un-worn** items from `after.equippedRequirements`, a dual-wield
note when the last enabler would leave, and two verdicts: `identical` and `noTrackedGain`
(every tracked pair `after ≤ before`, incl. secondary resistances, **and** the candidate
carries no grant, conversion or set — an annotation, never a cut).

### `src/core/context/builder.ts`

- `ContextInput.account?` (transfer-stash instances live there), `ContextOptions.projections`
  (default **false**), `ContextDoc.projections` (by dossier id).
- Trim ladder: first rung `candidate projections omitted` — a projection is derivable, a
  dropped candidate is not. Projections are computed once and cached across rungs.
- §7 preamble: what a projection is and is not (sockets as saved; sees exactly what §3
  counts; **projections do not add**; `no tracked figure improves` is **not a disposition**,
  a stored item is never sold), then **levers per resistance** — per cappable resistance, the
  top six free components (loose or craftable now) and §9 augments, with use-on and
  source/cost, stated as build-independent.
- Under each group heading, once: `worn in <slot>: <item> — leaves with it: component …
  (resists) — recovering it destroys <item> · augment … — lost; re-buy …`.
- Under each candidate, per target: `projected in <slot> (replacing <item>): <type-first,
  ` · `-separated, non-zero changes only> · unchanged: everything not listed`, with under-cap
  resistances in bold (Physical exempt), the endgame overcap target flagged, focus-type
  damage and the payload index, speeds, OA/DA/health/armour/absorption/sustain/attributes,
  moved ranks, set pieces (only where a side is ≥ 2), `<component> refits / does not
  refit`, un-wears, the post-swap requirement text, and the projection's notes.

### `src/core/session.ts`

`adviceScope` builds with `projections: true` in **both** branches, memoised per snapshot
(`WeakMap`) — the context viewer and the run both ask for it. `loadSnapshot` stays
projection-free: it runs on every watcher tick and its document only feeds ids to the
window. `contextFor` in the CLI goes through `adviceScope`, so `cli context` prints the
advice document, with `built in N ms (M candidate projections)` on stderr.

### `src/core/ai/prompt.ts`

Step 2: the projection is authoritative single-swap arithmetic; projections do not add; the
levers list is a table, not a recommendation. Step 7: `hold.beats`/`gains` may quote the line.

## Non-goals

- A tool-computed greedy baseline plan for the model to critique (the rejected alternative).
- Joint / pairwise projections (combinatorial, and literally the advisor's job).
- Dropping or re-ordering candidates by projection (breaks `candidateIds` coverage; feeds a
  ranking — the doctrinal line).
- Rendering projections in the UI tooltip (the renderer reads the envelope, not the doc).
- A mechanical check of the model's `gains` against the projection (buys paid repair calls).

## Verification

1. `npm run typecheck && npm test`.
2. `npm run cli -- context --char _Suchka`: projection bullets under every ranked candidate,
   ≤ 6 levers per resistance, nothing trimmed, stderr states the build time.
3. `npm run app:check` (mock advisor): unchanged behaviour; the context viewer's Raw tab
   shows the projection lines.
4. **Live A/B — real money, after the user confirms.** Copy the live save tree to a scratch
   directory and point every run at it with `GD_SAVE_DIR` so all six runs see the same
   bytes. `npm run cli -- advise --char _Suchka --json <arm>-<n>.json`, opus at medium,
   **N = 3 per arm, interleaved** (A B A B A B); the A arm is the same build with
   `projections: false` in `adviceScope`. The five stored opus‑medium runs on this character
   span 27k–40k thinking tokens, so one-vs-one reads noise. Compare medians of
   `usage.thinkingTokens` (primary), `durationMs`, `usage.outputTokens`, `firstWarnings`,
   `calls`, verdict count / slots covered, `projection.skipped`, resistances under cap in
   `projection`, and by reading: does the answer quote the projection figures.
   **Revert rule, pre-registered:** median thinking does not fall by more than the A arm's
   spread, *or* coverage / `firstWarnings` worsens in any B run → revert the document and
   prompt change; keep `projectVerdicts`, the two-hander fix and Part B.

## Outcome

**Shipped 2026-08-28, and the live A/B kept it.** Six opus‑medium runs through `claude-cli`,
interleaved A B A B A B on one frozen copy of the save tree (`GD_SAVE_DIR`), stash excluded
per the window's stored preference (both arms), A = `--no-projections` (the pre-stage
document, 66.7k tokens), B = the projected document (81.4k tokens). 41 minutes wall in
total, ~$8.5.

| run | thinking | output | seconds | first-draft warnings | slots | core move |
|---|---|---|---|---|---|---|
| A‑1 | 27,758 | 38,267 | 469 | 2 `ambiguous-stat` | 14 | off‑hand EQUIP `a7q9` + 2 augment buys |
| A‑2 | 27,935 | 38,024 | 457 | 6 `ambiguous-stat` | 14 | same |
| A‑3 | 34,470 | 45,265 | 543 | 5 `ambiguous-stat` | 16 | same + Head SWAP‑COMPONENT + inert set‑2 EQUIP |
| B‑1 | 11,943 | 20,219 | 252 | 2 `ambiguous-stat` | 14 | same |
| B‑2 | 19,935 | 29,980 | 365 | 0 | 14 | same + Head SWAP‑COMPONENT |
| B‑3 | 18,335 | 27,990 | 344 | 0 | 14 | same + Medal EQUIP |

- **Thinking: median 18.3k vs 27.9k (−34%)**, and B's *largest* (19.9k) is below A's
  *smallest* (27.8k) — a drop of 9.6k against an A‑arm spread of 6.7k, so the revert rule's
  first clause is cleared, not grazed. Output −27%, wall **344s vs 469s (−27%)**, cost
  median $0.93 vs $1.28 (the first pair paid full input price, the later four read the
  dossier from cache — same in both arms).
- **Coverage did not worsen**: every B run gave all 14 worn slots a verdict, zero
  `unaddressed-item`, zero projection skips, every resistance at cap after the plan in all
  six. A‑3's 16 slots were two extras — a component swap B‑2 also made, and an EQUIP into
  the *inert* weapon set. First-draft warnings fell (2/0/0 vs 2/6/5), all prose-only
  `ambiguous-stat` in every run, so no repair call was bought on either side.
- The answers converge: all six equip the same off‑hand with the same two fits and buy the
  same two augments (Nightshade + Solarstorm, assigned to hands/belt in either order);
  they differ only in the level‑94 hold and the optional second move. B did not quote the
  projection lines verbatim; it *used* them — which is the intended reading.
- Input grew 124.7k → 150.8k tokens per call (+21%): not a lever, as measured before, and
  the cost line above already includes it.

Numbers from the build itself, on `_Suchka`:

- **73 candidates → 100 projections** (rings and dual-wield one-handers into both slots),
  0 skipped, in **294 ms for the whole build** including the save read, resolution and the
  post-swap aggregates — so the perf fallbacks the plan held in reserve (`cloneLoadout`, a
  per-slot projection cap) were never needed. The document went from ~70.5k to **~88.3k
  tokens**: ~57k chars of projection lines, ~4k of levers, ~4k of per-group worn lines.
- Two shapes were tried and cut on the first live render: a `leaves with it:` line under
  *every* candidate (17k chars saying the same thing per slot — it moved to one line under
  the group heading, with only the per-candidate `refits` clause left on the projection
  line) and a `sockets as saved: component socket EMPTY` line (6.5k chars duplicating the
  block's own marker; the preamble says it once). Physical Resistance was being flagged
  `66 under cap` (§2 exempts it), and a `set 1 → 0 pieces` clause was noise (bonuses start
  at two).
- One real bug found by the live render: `heldClass` was a `const` declared *after* the
  loop whose hoisted `applyVerdict` called it — a TDZ error that silently skipped every
  off-hand projection (37 of 100) with the reason printed under each candidate, which is the
  degrade path working as designed.
- `useOnFlag` restates verify.ts's `slotFlagForClass` rather than importing it, so the
  context builder never depends on the answer checker.
- Part B: the live §3 line reads `sustain: 11.0% … — from Hands: Unholy Inscription 5%,
  Devotion: Fox 6%`; `_Suchka` has no attack skill with its own leech, so the §4 term is
  covered by the synthetic test only.

## Part C (follow-up, same session) — always-on granted skills are summed

Found by the user reading a live run: `_Bitch`'s 2026‑08‑28 answer recommended crafting the
worn **Deathchill** relic into **Scourge**, listing "+9 Cold Damage, +49% Cold Damage" as the
gain. That is Scourge's own lines minus Deathchill's own lines — arithmetic on exactly the
numbers the dossier gave it. Deathchill's *value*, though, is its granted **Deathchill Aura**
(a toggle, always on): **+125% Cold Damage, +22–29 flat Cold, +125% Vitality Damage, +66
Frostburn**, four times the relic's own `+36% Cold Damage`. With the aura counted the swap is
**−76% Cold Damage and −16.5 flat Cold** on a build §4 calls Frostburn + Cold — a loss sold as
a gain, alongside −35% Cold Res, −15% Vit Res and the irreversible consumption of the relic.
The model was not wrong so much as unarmed: it listed "Removes the Deathchill Aura toggle" as
a cost and put "Actual DPS including Deathchill Aura" in `notDerivable`, and the run four
hours earlier had *kept* Deathchill citing the same aura. The two runs disagreed on precisely
the thing no total contained.

Cause: the documented rule summed **no** granted skill, lumping six kinds under one sentence.
But the aggregate already bands invested skills by kind, and the aura's buff is
`SkillBuff_Passive` → `permanent`. Item-granted skills simply never reached the fold, because
the game does not persist them in `save.skills` (verified: zero of `_Bitch`'s 77 entries).

The change: **an item-granted skill is banded exactly as an invested one.**

- `grantedSkillRefs(slots, db)` reads `itemSkillName`/`skillName` off every part's stat block
  (base, affixes, completion, component, augment) — *not* `DbItem.grantedSkill`, which is set
  only when the **activator** record has a name of its own, and a toggled aura's name lives on
  the buff it points at. `grantedSkill` was therefore `undefined` for exactly this kind, which
  is why the aura was missing even from the "named, not summed" list — and why item-granted
  **dual-wield enablers** could be missed too (that lookup now goes through the same resolver).
  `skillLabel` follows the hop. Rank is `itemSkillLevel`, else 1.
- `permanent` (passive/toggle) and `maintainable` grants fold with a new `granted` source kind,
  labelled with the skill and noted `granted by <part>, toggle, reserves 150% energy` — the
  reservation being the one honest reason to discount the row. Procs, activated attacks and
  pet skills stay named-and-excluded, and the exclusion sentence now says which is which.
- **Every granting part counts, duplicates included**: two Vicious Spikes are two buffs, and so
  are two Coldstones. A dedupe was written first, on the assumption that a skill granted twice
  is granted once, and the user corrected it from the live characters — the opposite of the
  set-bonus rule, where a duplicate member adds nothing. Neither is derivable from the data;
  both are in-game facts, and the tests now pin this one.
- A grant that somehow *is* in `save.skills` stays with the invested fold — no double count.
- `CharacterAggregate.grantedSkills` gained `counted` and `activation`; §2 states the rule and
  the CLI marks each line.

Live effect: `_Bitch` Cold **+1443% → +1718%**, flat 242 → 287, Frostburn +1569% → +1719%.
`_Suchka` — whose worn helm grants `Glass Eye (passive — always on) — +10 Pierce Damage; +30%
Pierce Resistance` — effective **Pierce 146 → 176** and payload index **10,376 → 11,837**; the
matrix carries a new attributable row, `Head: Glass Eye *(granted by Sharpshooter's Glass Eye,
always on)*`, so a swap that would have silently dropped 30 points of Pierce Resistance is now
computable. Document +2.7k chars. Tests **386** (+2).

**The A/B above predates Part C** — both arms shared the same aggregate, so the comparison
stands, but the absolute token and document figures were measured before this landed.
