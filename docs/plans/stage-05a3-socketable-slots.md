# Stage 5A.3 — Socketable use-on slots & the extraction rules

> Follow-on prompted by review: an equipped or candidate item may hold the character's **only copy** of a component. The advisor must be able to say "destroy the old item, move its component to the new one" — and must never propose socketing a component or augment into a slot its restriction forbids. The restriction data existed but was untyped; the extraction mechanic was stated nowhere (and the 5B plan's "components are removable/replaceable" was misleadingly rosy).

## Format facts (verified against the installed v1.3.0.6 archives)

- **Use-on restrictions are boolean template fields on the socketable's own record.** Exactly 23 flag keys occur (`amulet`, `medal`, `ring`, `head`, `chest`, `shoulders`, `hands`, `legs`, `feet`, `waist`, `offhand`, `shield`, `sword`, `sword2h`, `axe`, `axe2h`, `mace`, `mace2h`, `dagger`, `scepter`, `spear2h`, `ranged1h`, `ranged2h`), only on `ItemRelic` (components, 107 records) and `ItemEnchantment` (augments, 384), and only ever with value 1 — zeros are template noise the extractor already drops. No gear record carries any of them. The single flagless augment is the dev blank `a00_blank.dbr`.
- **The Inventor's salvage is an either/or, verbatim from the game's own UI strings** (`tagDividing*` in `Text_EN.arc`):
  - `tagDividingKeepItemWarning`: "Choosing to salvage the item will destroy the attached Component and remove any Augments."
  - `tagDividingKeepComponentWarning`: "Choosing to salvage the Component part will destroy the item and any Augments."
  - `tagDividingRemoveAugmentWarning`: removing an augment destroys it (and lifts its Soulbound property).
  - `tagDividingCost`: "Salvage Cost:" — it's an iron fee.
  So: extracting a component to reuse costs the host item; keeping the item costs the installed component; an augment is never recoverable, in any direction.
- **Partial components no longer exist in the game** (removed v1.1.2.0; `completedRelicLevel` is 1 on all 107 component records). The save's `relicCompletionLevel` is legacy; "completion state" needs no modelling.
- An item carries up to one component *and* one augment, in independent sockets — the save's `relicName` and `augmentName` on the same item struct, both already parsed and resolved.
- Already covered before this stage, confirmed by exploration: installed components and augments are resolved on every item in every container (`resolve.ts`) and folded into the resistance matrix per equipped slot (`aggregate.ts`). What was missing was the *typed restriction* and, for 5B, an ownership census (nothing counts copies across containers).

## Deliverables

- DB schema 7: `DbItem.allowedSlots?: string[]` — the raw flag names, lifted for `ItemRelic`/`ItemEnchantment` records; the flags leave `stats` (they'd render as junk stat lines). `DbStats.socketables` for coverage.
- `db --stats` prints the socketables count.
- 5B plan updated: §2 gains the verbatim-grounded socketable rules (either/or salvage, slot legality, one-of-each); §8 becomes a **component census** across all containers with `single instance — extraction destroys <host>` marks; §5 drops the moot completion state; §7 notes candidates as extraction sources; acceptance 6c added.
- Stage 6 plan updated: new procedure step 8 (legality check + sourcing order loose → craft → extract-with-destruction; replacement destroys the installed component); `AdvisorPlan` verdicts gain `componentFrom?`; mechanical acceptance checks 4c (a destroyed host carries no other verdict) and 4d (socket legality validated against `allowedSlots`).

## Acceptance criteria

1. Known socketables carry the right restriction: Attuned Lodestone → `['amulet','medal']`, Seal of Might → weapons+shield and not `chest`, a jewelry augment → `['amulet','ring']`; the flag keys are gone from `stats`.
2. `db --stats` reports socketables ≈ 490; cache size unchanged; schema 6 → 7 rebuilds once.
3. `npm test` + `npm run typecheck` green; `resolve --char _Suchka` output unchanged.

## Outcome

Implemented as planned; all criteria pass (146 tests). Notes:

- Coverage: 490 socketables (107 components + 383 augments, the dev blank excluded by having no flags). Cache 19.7 MB — unchanged.
- The Inventor rules were verified against the installed game's `Text_EN.arc` rather than the wiki, and matched it: salvage is either/or destructive, augments are always lost. The community wiki agreed; a suspected v1.2 "free removal" QoL change does not exist.
- No resolver/aggregate changes were needed — installed components and augments were already resolved everywhere and matrix-folded per slot; the census itself is 5B-builder work by design (it is a rendering-time grouping over `ResolvedItem`s, not game mechanics).
