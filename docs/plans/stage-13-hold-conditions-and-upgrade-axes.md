# Stage 13 — Hold for a drop, and the upgrade axes

## Context

Two observations from playing with the advisor, both about the ARPG loop the tool is meant
to serve — a loadout is improved piece by piece for as long as the character is played, and
every drop is either an upgrade now, something to keep for later, or trash:

1. An item can be a real upgrade on one axis (big on-type flat damage, 1.5× the armour, a set
   piece, `+N` to the attack skill) and still not go on today, because the single swap opens a
   resistance the current levers cannot close. The right call is to **hold it until a drop
   covers the gap** — a chest or head carrying the missing resistance — and the prompt had no
   such hold: the only kind it defined was "until level N / N attribute points".
2. With every resistance capped, the plan must not read "nothing to do, sell everything" — the
   remaining budget is damage, health, armour, Offensive/Defensive Ability, sustain.

Two facts settled what to change, both read off the stored envelopes and the live saves rather
than assumed:

- **Every hold in all twelve stored runs is a level or attribute threshold.** Not one is
  "until a drop covers what this opens". The model does what the prompt defines and nothing
  else, so the missing kind had to be defined.
- **The level-78 character has ten level-94 legendaries in the transfer stash that the model
  has never been shown** — Deathmarked Shoulderguard (the second piece of the set it is
  wearing), Mindwarp, Stormbearers, Gloom Knight's Emblem… The candidate window was −25/+10
  around the character's level, so anything past 88 was dropped before §7 was written, and
  the last answer's "no threshold is worth committing to" was true of what it saw and false
  of what the character owns. `_Suchka` at 88 has nothing above +10, which is why the runs on
  that character never showed it.

## What changed

**A. The window reaches +20 for Epics and Legendaries** (`levelWindowAbove` in `filters.ts`;
`LEVEL_WINDOW` exported so the §7 footnote states the rule). Endgame gear is level 94 and a
character starts finding it from the mid-70s. Rarity-gated because a rare fifteen levels up
is junk by the time it is wearable and a legendary is the target — so the wider reach costs
blues and greens nothing. Measured on `_Bitch`: 25 → 35 candidates, ~58.4k → ~63.8k tokens,
and §12 gains one rung, "At level 94 (16 levels away) — 10 items unlock". `_Suchka` is
byte-for-byte the same document.

**B. A second kind of hold** (prompt step 7e, the HOLD paragraph, the output-format bullet,
the plan-block rules; §11's HOLD bullet and the §7 "Ranked by" line in the document): wearable
now, a real upgrade on a named axis, but the single swap — read off §7's projection line —
opens a cost nothing in the dossier covers today: a resistance under cap with no lever and no
joint move, a broken set, the last dual-wield enabler. `until` names the *kind* of drop that
would close it ("a Chest or Head carrying ≥30% Aether Resistance", "the third Deathmarked
piece"); `needs` is omitted; there is no `nextLevels` entry, because that list is levels and
points. Three disciplines travel with it, because the risk of a new hold kind is that it
becomes "keep everything shiny":

- it is the **fallback, not the first resort** — try the levers, a re-augment elsewhere and a
  joint move first; a hold that a joint move would have made an EQUIP is a missed move;
- `gains` and `reason` quote the gain *and* the cost from the projection line;
- the existing guard stands — `slot`, `beats`, `gains` — and gains a fourth: **`until`**.
  `checkPlan` now reports a hold with no exit condition as `unjustified-hold` ("until when it
  is held"), because a hold with no condition is a stash decision, not a plan. "Better times"
  is named in the prompt as not a condition. All twelve stored runs already filled `until`,
  so the check costs nothing on the answers seen so far.

An on-build set piece is held for its set even when it loses on its own, when the pieces
owned reach a bonus the build wants — §6 already prints the worn/owned counts and what the
next piece adds.

**C. The upgrade axes** (prompt step 3): "resistance-complete is not done" was one sentence;
it is now an explicit list of where the next upgrade is judged and where each number lives —
offense (on-type flat scaled by §4's column, on-type `+%`, OA, crit damage, attack speed below
cap, RR, `+N` to attack/RR skills via §4's rank tables), defence (health, DA, armour on the
weakest body part, Physical Resistance, sustain, block, the other resistances §3 lists),
utility (movement speed below cap, energy). Every candidate ends as an upgrade now, a hold
with a condition, or a sale — and a KEEP on a slot that has candidates names the axis on
which the worn item wins.

## What was considered and left out

- **A mechanical check that a hold's projection shows a gain.** Decidable for a threshold
  hold (the projection is against today's loadout) and wrong for a drop hold, whose value is
  conditional on a joint move the projection does not model; and the failure being fixed is
  under-holding, not over-holding. `slot`/`beats`/`gains`/`until` are the guard.
- **A typed `needs.cover` for the resistance a drop hold waits on.** Nothing reads it yet; the
  `until` sentence is what the UI shows and what the reader acts on. Add it when a "looking
  for" view exists to consume it.
- **Widening the window for every rarity.** Blues and greens far above level are not what a
  player stashes; the tokens would buy nothing.
- **Softening "never leave a resistance under cap for damage".** Step 4 already permits an
  argued exception; a drop hold is the honest answer to the case that tempted it.

## Acceptance

- `npm run typecheck && npm test` — a Legendary at +15 and an Epic at +20 are ranked, a Rare
  at +15 and a Legendary at +21 are not; a hold with `until` naming a drop passes `checkPlan`
  clean, a hold without `until` is `unjustified-hold`.
- `npm run app:check` passes (the mock's hold already lacked `slot`/`beats`; nothing new).
- `cli context --char _Bitch` lists the ten level-94 legendaries under §7 with projections,
  and §12 carries the level-94 rung.

## Outcome

Prompt and window change; no live A/B was run — the change is what the model is *allowed*
to say, not how much it reasons, and a run costs minutes and money. What the next live run on
`_Bitch` should show, and what to look at first: a HOLD on Deathmarked Shoulderguard
(`until: level 94`, for the set) and a `nextLevels` rung at 94; and on `_Suchka`, whether the
shoulders candidate whose projection reads "Fire Resistance 86 → 107 · Cold Resistance 84 →
117 · Acid Resistance 106 → 46 (**34 under cap**)" is handled as a joint move, a drop hold,
or — the failure this stage is for — a sell.
