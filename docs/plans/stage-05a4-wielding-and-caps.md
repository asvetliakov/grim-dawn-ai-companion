# Stage 5A.4 — Wielding modes, set duplicates, engine caps & rule-book fixes

> Follow-on prompted by the user's "are we missing anything else? check the wiki" gap audit. A code sweep plus wiki verification found four modelling gaps and three missing game-rule statements ahead of 5B freezing the context format.

## Format facts (verified against the installed v1.3.0.6 archives)

- **Dual-wield enablement and DW-conditionality share one marker.** `dualWieldOnly` / `dualRangedOnly = 1` on a skill record means "inert unless dual-wielding that family". The same flags identify the enablers; there is no separate enable field anywhere in the data (the only DW template class, `Skill_PassiveDualWieldWeapon`, covers just the ranged Gunslinger's Talent). Telling enablers apart is a documented heuristic, spot-verified against tooltips and the wiki:
  - An **invested mastery skill** enables only when it is a plain passive — Nightblade's Dual Blades (`playerclass04/wpattack0.dbr`, FileDescription literally "enables dual wield…"), Berserker's Implements of War (`playerclass10/passive01.dbr`). The flagged WPS attacks and transmuters beside them (Whirling Blades, Breath of Belgothian, Frenzied Cry) merely *require* dual wielding — the first live run listed the transmuters as enablers, which is why the scan whitelists passive classes.
  - An **item-granted flagged skill of any class** enables — every item whose tooltip reads "allows you to dual wield" grants one: Direwolf Crest → Direwolf Claw, the Mutilation relic → Mutilate, Slaughter → Bloodbath (wiki-confirmed), Gunslinger's Jacket → Gunslinger's Talent.
- **Set counters count distinct members.** Two copies of the same set ring advance the in-game counter by one (user-verified in game). The aggregate previously counted each equipped copy — over-reporting bonuses for doubled pieces.
- **Player speed caps live on `records/game/gameengine.dbr`**: `playerAttackSpeedCapMax = 200`, `playerSpellCastSpeedCapMax = 200`, `playerRunSpeedCapMax = 135` (mins all 20; the boss/monster caps beside them don't apply to players).
- **Conversion pairs stop at suffix 2.** `conversionInType`/`OutType`/`Percentage` appear only bare (10,991) and with suffix `2` (1,379) — no record carries a third pair, so the existing two-suffix reader is provably complete. The damage *ranking* still doesn't apply conversion; that stays a disclosed limitation (exclusion line) with conversion-aware ranking in the backlog.
- **Soulbound** (community-verified): applying an augment soulbinds the item — no trading, no transfer stash — until the augment is removed, which destroys the augment (consistent with 5A.3's `tagDividingRemoveAugmentWarning`).
- **Respec economy** (wiki-verified): skill points refund at the Spirit Guide for iron (rising cost, 15k cap/point); the mastery bar can be reduced; the class combination is permanent. Attribute points refund only via Tonic of Reshaping — two from quests, then craftable at hidden Celestial Blacksmiths in Elite/Ultimate.

## Deliverables

- `aggregate.ts`: set-piece counting deduped by item record; `CharacterAggregate.wielding` (`WieldingSummary` — mode from the held weapons' classes, plus named `dualWieldEnablers` with sources); DW-conditional skills excluded (with a dedicated exclusion reason) when the loadout's mode doesn't match their family.
- `skills.ts`: `dualWieldFlag()` (reads the flags off the record or its buff hop); `EXCLUSION_REASONS.dualWield`.
- DB schema 8: `GameDb.speedCaps()` from the engine record (same pattern as `armorAbsorptionBase`), defaults 200/200/135.
- CLI `aggregates`: wielding + enabler line, loud model-gap warning for dual-wielding with no enabler, speed-caps line.
- 5B plan §2/§4 and stage-6 plan steps 1/7/10 updated with the new rules (speed caps, dual-wield enabler preservation, soulbound, respec economy, conversion caveat).

## Acceptance criteria

1. Stub: a duplicate set ring counts once (no two-piece bonus); distinct members count normally.
2. Stub: mode detection (dual/shield/single/unarmed); invested flagged passive is an enabler, flagged WPS and transmuter are not; item-granted flagged skill is; a flagged passive's stats are inert behind a shield and counted while dual-wielding, with the exclusion line saying why.
3. Live, "wielding it proves it": any character in a dual-wield mode names ≥1 enabler; `_Suchka` reads `dual-wield melee` with Dual Blades among the enablers.
4. Live: `speedCaps()` = `{attack: 200, cast: 200, run: 135}`.
5. Before/after diff of `aggregates --char _Suchka`: only the new lines — no numeric drift.
6. `npm test` + `npm run typecheck` green.

## Outcome

Implemented as planned; all criteria pass (153 tests). Notes:

- The first live run exposed the transmuter false-positives (Breath of Belgothian, Frenzied Cry listed as enablers), fixed by whitelisting passive classes for invested skills — and in doing so revealed that `_Suchka` is a Nightblade/**Berserker** whose second enabler is Implements of War, plus a third from the Slaughter relic. The enabler list is genuinely load-bearing: it shows the advisor that dual-wielding survives losing any one of the three.
- `_Suchka`'s numbers were unchanged by the set-dedupe fix (no doubled set pieces) and by the banding change (an actual dual-wielder keeps Dual Blades' stats, which were already counted); the fixes matter for other loadouts and for candidates-after-swap reasoning.
- `_abcdef` reads `two-hander (Maul)` — no enabler required, none listed.
- Conversion needed no reader change (two suffixes are provably all there is); the ranking's blindness to it is now stated in the exclusions rather than silent.
