# Stage 14 — Closable gaps, and the socket carry-over

## Context

Three stored codex `gpt-5.6-sol` runs on `_Bitch` on 2026-08-28 (`advice/_Bitch/2026-08-28T{00-28,01-30,16-17}*.json`)
returned KEEP on 13–16 of 16 slots. The one that mattered — 16-17Z, level 84, effort high, stash
excluded, built six minutes after the Stage 12/13 build so it saw projections *and* the levers
table — equipped Head + off-hand, **held** Shroud of Illusion and Sellecor's March "until a drop",
and **sold** Shadoweave Leggings, Dreadweave Girdle and Crest of Winter Fortitude. The user
equipped all five anyway. By the tool's own projections (16-17's `before` → 17-32's `before`):
flat health 5,845 → 7,385, hit-weighted armour 1,662 → 2,211, weakest part 1,293 → 1,637, payload
~2% over the plan's — at the cost of Acid 81 → −20, Bleeding 80 → 50, sustain 17 → 12. The next
run (17-32Z) closed every gap in 6.7k thinking tokens with five Venomguard Powders, two Silk
Swatches and a Runestone — all of them in the levers table the 16-17 run had in front of it.

Why it said KEEP, mechanically:

1. **The socket-package bias.** The worn loadout carried its Acid almost entirely in sockets
   (Antivenom Salve +20 and Mogdrogen's Touch +12 on *both* Feet and Belt = 64 of the 81).
   `candidateProjections` projected every candidate as a bare `EQUIP` — "sockets exactly as
   saved", i.e. empty for a drop — against a fully socketed worn item, so every upgrade printed
   `Acid Resistance 81 → 47 (**33 under cap**)` and the model booked the socket package's loss
   as the candidate's own cost. Its hold reason says so: *"even Antivenom Salve and Mogdrogen's
   Touch leave a 13-point Acid Resistance gap"* — within-slot arithmetic, never the loadout-wide
   re-augmentation that closes it.
2. **Nothing computed or checked the composition.** The prompt said "projections do not add — a
   joint move is yours to sum" and "try a re-augment elsewhere, hold only when that fails", and
   no arithmetic backed it and no check tested it. An *existing* shortfall got step 2's "fix it"
   mandate; a shortfall *a swap would open* got the swap declined.
3. **KEEP was free.** `checkPlan` had no KEEP-aware logic and `sell` discharged
   `unaddressed-item`, so "keep everything, sell the bags" was the unique zero-work path through
   the checks. Stage 13's Outcome named this case as the thing to look at first.

Hand-checked against the 16-17 `wornSockets` while planning: re-assigning the seven *armour*
augment sockets alone cannot close Sellecor's March's gap — every Venomguard (+18 Acid) displaces
a Mankind's Vigil / Spellward / Mogdrogen's Touch whose Aether or Vitality line the loadout cannot
spare. What closed it was **the incoming item's component socket** (Antivenom Salve in the new
boots) plus one belt re-augment. So the search treats that socket as a variable too.

Side defects found on the way: `CRAFT Runestone` written for a *craftable component* skipped the
projection (17-32 computed Acid 70 against a claimed 82, and `overstated-cap` stood down on the
skip); §7 ranked Physical Resistance as a shortfall the rest of the document tells the model to
ignore (`builder.ts` built `shortfalls` without the `physical` exclusion §3 applies — Stormbearers
ranked first in Feet on it); the levers table never listed loose augments on hand; and the
empty-socket check covered components only.

## What changed

**A. Like-for-like socket carry-over** (`projections.ts`). Each candidate is projected as
`EQUIP` **plus `fits`**: the outgoing component where it refits and can be had (a loose copy,
craftable now, else by salvaging the outgoing item — `CarriedSocketable.via`), the outgoing
augment where the candidate's class accepts it and a reached vendor sells another. A socket the
candidate was saved with stays as saved. The line's `sockets:` clause says what was assumed and
what it costs, so the figures are the item's own delta. The completion-bonus note moved to the §7
preamble (it would otherwise sit on every line that carried a component).

**B. The `closable:` witness** (`closable.ts`, called from `candidateProjections`). For every
cappable resistance the like-for-like swap leaves short of where it has to be — the cap, or the
pre-swap figure for one already short — one assignment of the loadout's **armour augment
sockets** (pure resistance lines in the installed database, ten of thirty-nine with a defensive
side line, none with damage, OA, `+skills` or `+% Maximum Resistance`, so the arithmetic is exact)
and the **incoming item's component socket** (empty or carried, never saved-full) that closes
every gap without opening another. Greedy by largest shortfall reduction, then a bounded
depth-first pass; the witness is re-applied through `projectVerdicts` and claimed only when the
real aggregate agrees. Printed with ids, what each re-augment displaces and what that gives up,
and the iron: `closable: Venomguard Powder `#yqux` on Belt in place of Mogdrogen's Touch · Antivenom
Salve `#20hb` in the Feet socket (a loose copy) — 4,000 iron; closes every gap the swap opens`, or
`not closable by re-augmenting armour and the incoming socket — jewellery and weapon augments,
other components and joint moves are yours`. A witness that it can be done, not the way to do it:
nothing feeds `score` or order.

**C. Wording** (prompt steps 2, 3 and 7e; §7's preamble and Ranked-by line; §11's KEEP, HOLD and
CRAFT bullets). A gap a swap opens is a shortfall like any other and step 2's procedure applies
to it; every armour augment socket on the whole loadout is a free variable; a KEEP on a slot with
candidates names the axis it wins on *with its number* and names a candidate whose line says
`closable`; a drop hold is for a line that says `not closable`; CRAFT is for §10's relics and gear,
a component into a socket is ADD-/SWAP-COMPONENT.

**D. Checks** (`verify.ts`, threaded through `ContextDoc.projections` / `freeAugmentIds` exactly
as `freeComponentIds` is, in `src/main/advise.ts` and the CLI):
- `avoidable-hold` — structural, buys the repair call: a hold with no level or attribute
  condition on a candidate whose projection into that slot has a gap the tool marked closable
  (a set break or a dual-wield note keeps the hold legitimate; a hold on a swap that opens no gap
  is left alone — it may be waiting on sustain or a rank, which is not the projection's call).
  Against the stored runs: fires on both 16-17 holds, rightly; silent on the other three.
- `unargued-keep` — wording only, never a call: a KEEP that names *none* of the candidates in
  its slot that are wearable now, improve a tracked figure and open nothing not closable (naming
  one is enough — the first draft demanded every one, and a weapon slot has a dozen). On 16-17 it
  fires on Legs, Belt and Medal — exactly the live failure. A SELL is not checked on its own: a
  slot whose KEEP argues nothing already warns, and one whose KEEP argues its strongest rival has
  argued.
- `unfilled-socket` now covers the **augment** socket: an item ending the plan with none while
  the plan's own projection leaves a cappable resistance under cap and a reachable augment legal
  on the slot raises it. Stands down on a partial projection, as `overstated-cap` does; the
  projection is computed once per `checkPlan` and shared.
- `CRAFT` naming a component is projected as installing it (`project.ts`) and checked for socket
  legality like any socket verdict.

**E.** `shortfalls` excludes `physical` (`builder.ts`, with a comment pointing at §3's rule).
**F.** The levers table lists loose augments on hand ahead of the vendor copy of the same augment
(`augmentCensus`, lifted out of §8's renderer; `vendorStock` exported for the augment universe).

## What was considered and left out

- **`dismissed-upgrade`** — a warning on the *sell* of a "dominant" upgrade (a tracked gain with
  no tracked loss besides closable resistances). It fires on none of the five items the user
  equipped — each lost sustain, a skill rank or Night's Chill — and any wider criterion has the
  tool ranking health against sustain, which `filters.ts` refuses to do. The honest mechanical
  claim is `unargued-keep`: not "you were wrong", but "you did not say".
- **A `--no-closable` control arm.** A and B change the same lines, the 16-17 save no longer
  exists, and the outcome is a per-item disposition, not a token count; the three stored runs
  are the control.
- **Jewellery and weapon augments in the search.** They carry damage and Offensive Ability;
  choosing among them is the model's job. `not closable` is scoped to say so.
- **Promoting `unargued-keep` to a repair-worthy kind.** Each unargued slot would buy a call;
  decide after a live run shows whether the wording alone moves the model.

## Acceptance

- `npm run typecheck`, `npm test` (408 passing: carry-over via loose / salvage / not-refit /
  no-vendor / already-socketed; closable via a re-augment, via the incoming component, never by
  trading one gap for another, never displacing a carried component whose lines the fill would
  lose; CRAFT-of-a-component projected and checked; the three checks with their silences; the
  Physical shortfall and loose-augment levers on the live document; every new clause clean under
  the qualified-stat check), `npm run app:check`.
- `npm run cli -- context --char _Bitch`: 65 candidate projections in 264 ms; `sockets:` on
  every line with an outgoing socketable, `closable:` on 6 lines and `not closable` on 11; the
  three clauses cost ~2.8k tokens on an ~84k document; no "shortfall in physical" note.

## Outcome

**Shipped 2026-08-29, with one live run** (`cli advise --char _Bitch --no-stash`, codex
`gpt-5.6-sol` at high, the character as it stood after the user had already made the swaps the
16-17 run declined and the 17-32 run had capped): 199 s, one call, 9.6k thinking / 14.5k output
tokens, document ~78k tokens, zero structural warnings. What the run did with the new lines:

- **It composed a joint move across three slots** — Ancient Armor Plate replacing a redundant
  Silk Swatch on the chest, Unholy Inscription replacing Consecrated Wrappings on the hands,
  Mankind's Vigil on the belt — and stated what each opens and what the next one closes; the
  computed projection agrees: hit-weighted armour 2,241 → 2,430, absorption 84 → 89.6%, global
  sustain 5 → 10%, every resistance still at cap, payload −0.1%. The 16-17 run never composed
  a move that reached past the slot it was judging.
- **Every KEEP names the candidate it beats and by how much**, in the line's own words: *"beats
  resistance-closable Shieldmaiden's Guard `#i9qv` by 6.9% weapon payload index, 63 Offensive
  Ability…"*, *"beats resistance-closable Final March `#70ws` by 2.7% weapon payload index, four
  Movement Speed points and two Amatok's Pact ranks"*. Four of the sixteen use the phrase
  "resistance-closable" — it read the clause and argued past it rather than stopping at the gap.
- **No drop hold on a closable line.** The two holds are a level threshold (Stormcaller's
  Circlet, `needs.levels: 8`, with the resistance it would open named in `until`) and an
  awakening base; `avoidable-hold` had nothing to catch. The drop hold is still unexercised
  on a `not closable` line — the shoulders candidate on `_Suchka` remains the thing to watch.
- **`unargued-keep` fired four times on the first draft and taught something**: the weapon
  KEEPs argued the strongest of eleven and three arguable candidates and were told to argue
  the rest, and the SELL half listed twenty items. The check shipped narrowed — a KEEP that
  names *none* of its arguable candidates, no SELL half — under which this run would have drawn
  one warning (Shoulders: it argued Bloodfury Spaulders, which needs a level, and not the
  wearable Mystic Wight Lord's Shoulderguards). Wording only; it bought no call.
- Whether the *earlier* failure recurs cannot be re-run: that save no longer exists. What can
  be read off this run is that the four mechanisms are exercised — the `sockets:` clause is
  cited, the `closable:` witnesses were composed past, the KEEPs name their rivals — and that
  the answer is a plan of moves rather than a list of reasons to keep.

## Review, and what it changed

`/code-review high` over the commit found four things, all fixed in the follow-up:

- **The search budget was per component option, and each node re-sorted its socket's
  augments.** Measured on a synthetic worst case (7 sockets, 25 augments, 12 components, a goal
  nothing reaches): **1,055 ms for one slot**. `adviceScope` runs this ~100 times in the Electron
  main process. The budget is now shared across the whole `findClosable` call, the augments'
  resistance vectors are resolved once, the DFS takes them in a static order instead of ranking
  per node, and the cap is 4,000 nodes — no budget makes 26^7 exhaustive, so it is a time bound
  and exhausting it under-claims. Same worst case: **40 ms**. On the live document, same save,
  before and after: 230 ms vs 225 ms, the same 11 closable and 7 not-closable slots, one witness
  naming a different but equally valid augment (both verified against a real aggregate — the
  point of "a witness, not the only way").
- **`avoidable-hold` never checked `wearable`.** `needs` is optional in `holdSchema`, so a hold
  stating "until level 94" in prose alone reached the check and would have bought a repair call
  telling the model to EQUIP an item the character cannot put on. It now skips an unwearable
  candidate and one whose swap un-wears a third item — structurally, rather than trusting the
  model to fill `needs`.
- **The empty-augment check compared `after < capAfter` on 0.1-rounded figures**, so a 79.9
  reported "0 under cap" and bought a corrective call on rounding — the trap `checkOverstatedCaps`
  keeps its ±2 for. It now needs a full point.
- **`unargued-keep` counted candidates the plan was already using.** A ring projects into both
  fingers, so `EQUIP` in Ring 1 plus `KEEP` on Ring 2 warned that the KEEP argued against
  nothing. Candidates the plan equips, holds, spends as an enabler or destroys as an extraction
  host are now excluded; a *sold* one still counts, which is the failure this check exists for.

One unrelated bug surfaced while re-running the suite: `test/advise-runner.test.ts` took its
snapshot from `primaryLiveCharacter()` — the highest-level character — and then asserted the
name `_Suchka` in six places. The user levelled `_Bitch` to 90 past `_Suchka`'s 88 during this
session and six assertions failed on a fact about the save rather than about the run manager,
which is exactly the failure `test/paths.ts` documents. The name is now derived.

Gate after the review: **411 tests** (+3), `app:check` green, live document 225 ms / 46
projections.
