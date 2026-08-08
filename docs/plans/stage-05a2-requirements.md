# Stage 5A.2 — Item requirements & character attributes

> Follow-on to Stage 5A, prompted by review: the advisor must never suggest equipping an item the character can't wear, must distinguish "HOLD until level N" from "wrong build, sell it", and must see the `-% Requirement` modifiers on skills/devotions/items. None of that was computable: `DbItem` carried `levelReq` only, and the character's attributes were parsed but never combined with gear/skill bonuses.

## Format facts (verified against the installed v1.3.0.6 archives)

- **Attribute requirements are not stored on items.** The explicit `strengthRequirement`/`dexterityRequirement`/`intelligenceRequirement` fields are zero on every item except one quest item (`quest_areah_woodcarving_02.dbr`, str 800 — treat any non-zero as an override). Real values come from equation strings in the 13 `records/game/itemcostformulas*.dbr` records, referenced via `itemCostName` on 6,395 gear records, evaluated at the item's `itemLevel`. Internal naming: strength = Physique, dexterity = Cunning, intelligence = Spirit.
- The equation grammar is `+ - * / ^ ( )`, numbers, and the variables `itemLevel` and (rings/amulets only) `totalAttCount`. Which equation applies is the item's `Class` → key-prefix routing (chest/legs/head/…/axe/sword/melee2h/shield/amulet…); the caster cost files give chests/helms **dual** Int+Str requirements and daggers Int+Dex. Spears have no equations of their own anywhere — `Spear2h` reads `melee2h`. Medals map to a family that is never populated: a medal genuinely requires nothing.
- `totalAttCount` is the count of populated stat entries on the *rolled* item. Only ring/amulet equations use it, linearly (~3% of `itemLevel × 3` per stat). Counting must be restricted to real stat keys (`character*`, `offensive*`, `defensive*`, `retaliation*`, `augment*`, `skill*`) — metadata like `itemLevel` and `attributeScalePercent` inflates a ring's Spirit requirement by a few points per miscounted key, which is exactly how the live gate first failed.
- `attributeScalePercent` is **not** a requirement multiplier (it scales granted attribute bonuses); the eqnVariable `itemAttrScale` appears in zero shipped equations.
- **Level requirement is always the explicit field**, never an equation (every `*LevelEquation` is empty; 516 records have `levelRequirement ≠ itemLevel`, so never substitute). Affixes carry their own `levelRequirement` (6,075 non-zero): a rolled item's gate is `max(base, prefix, suffix)`. Components/augments/relics gate on level only.
- **Requirement reductions**: `character<Scope><Attr>ReqReduction` percent fields with scopes Global / Armor / Jewelry / Shield / Weapon / Melee / Hunting (Staff and Weapon2H defined but unused), plus flat `characterLevelReqReduction`. ~80 records: devotion nodes (scalar 10s), Soldier's `passive2.dbr` with a 20-entry per-rank array (3→25%), medals/waists/relics/torsos (10–15), seven Global affixes (9–12). Additive stacking, Global on top of scope. Fifteen medals carry the field *zeroed* — skip zeros.
- **Character attributes**: the save's physique/cunning/spirit are base + allocated only. Mastery bars grant attributes as cumulative per-rank arrays on `_classtraining_class{NN}.dbr` (Soldier +5 Physique/rank); gear/affixes/skills add `characterStrength/Dexterity/Intelligence` (+`Modifier` %). Total = `(saveBase + Σflat) × (1 + Σ%/100)`.

## Deliverables

- `src/core/db/formula.ts` — recursive-descent evaluator for the equation grammar (no `eval`).
- DB schema 6: `DbItem.attrReq` / `attrReqPerStat` (baseline at `totalAttCount = 1`; jewelry's linear step recovered by evaluating at 2 and differencing), `DbAffix.levelReq`, `DbStats.itemsWithAttrReq`; `records/game/itemcostformulas` added to `WANTED_PREFIXES`; render/physics and loot-table junk keys dropped from `stats`.
- `ResolvedItem.requirements` — `{ level, physique?, cunning?, spirit? }` for the rolled item.
- `src/core/mechanics/requirements.ts` — reduction collection (scope × attribute rows + flat level), `scopesFor`, `checkRequirements` (reports, never filters: a reduction or +attribute can come from the very item a swap would remove — the advisor owns post-swap reasoning).
- `stats.ts` attribute vocabulary incl. OA/DA contributions (5B promised OA/DA; 5A had skipped them).
- `CharacterAggregate.attributes` / `requirementReductions` / `equippedRequirements`; CLI `aggregates` and `resolve` render all of it.

## Acceptance criteria

1. Evaluator reproduces the probed magnitudes on verbatim equations: chest@30 → 218.2, ranged2h@70 → 479.5, amulet@75 → 312.1.
2. Known records carry the right requirements: `d008_torso` 829.8 Physique, `b008c_gun2h` 479.5 Cunning, `c044_necklace` 312.1 Spirit + 2/stat, medals none, the quest-item override 800.
3. **The wearing-it invariant**: every equipped item on both live characters passes `checkRequirements` — the end-to-end gate on equation routing, stat counting, reduction scoping and attribute totals at once.
4. Reduction scoping is exercised: a Melee reduction must not touch a ring; zeroed fields add no row; the Global affix stacks on scope reductions.
5. `db --stats` reports `itemsWithAttrReq` > 5,000; cache growth negligible.
6. `npm test` + `npm run typecheck` green.

## Outcome

Implemented as planned; all criteria pass (145 tests). Notes:

- The routing table covers all 23 item classes that reference `itemCostName`, confirmed by scanning the archives — `WeaponMelee_Spear2h` (44 gdx3 records) was the only class the original probe missed, and `templates.arc` proves no spear equations exist, so it rides `melee2h`.
- The live gate caught a real modelling bug on first run: `_Suchka`'s Amarastan Sigil read "need 306 Spirit, have 299" because the jewelry stat count included `itemLevel`, `attributeScalePercent` and five render/physics keys that had survived Stage 3's stat extraction. Fixing it meant both whitelisting counted keys in the resolver **and** dropping the junk keys from `DbItem.stats` (they were noise headed for the advisor context anyway). With the corrected count the ring reads 326 raw / 293 after the Dryad's −10% Jewelry Spirit — and the character's 299 clears it, as wearing it proves.
- Requirements displayed by `resolve` are the **raw** rolled-item numbers; the reduced number lives in `checkRequirements.effective`, because reductions are a property of the character, not the item.
- External spot-check: the community wiki lists the Amarastan Sigil at 322 Spirit; we compute 326 — the jewelry stat-count approximation overshoots by ~1%. Overestimating is the safe direction (the advisor will never call an unwearable item wearable), and the wearing-it gate bounds the error in practice.
- The 5B plan's §2 carried the stale uniform "Elite −25 / Ultimate −50" difficulty blurb that 5A had already disproved; fixed while wiring requirements into the 5B/6 plans.
- Cache: 20.5 MB (junk-key removal paid for the new fields). Schema 5 → 6 rebuilds once.
