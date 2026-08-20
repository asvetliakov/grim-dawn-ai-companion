# Stage 10 — Faction boosters: Writs, Mandates and Warrants

## Goal

Grim Dawn sells three consumables that multiply reputation change:

| item | class | multiplier | the save field it sets |
|---|---|---|---|
| **Writ** (`boost_*_a01`) | `ItemFactionBooster` | ×1.5 | `positiveBoost` |
| **Mandate** (`boost_*_b01`) | `ItemFactionBooster` | ×3 | `positiveBoost` |
| **Warrant** (`boosthostile_*_c01`) | `ItemFactionWarrant` | ×3 | `negativeBoost` |

Fifteen factions sell a writ line, twelve sell a warrant — 27 purchases at
15k–100k iron each, found and used one at a time. This stage applies all of them
to a character in one command.

Scope, decided with the user before any code:

| | |
|---|---|
| **What is written** | The *effect*, not the items: two floats per faction in block 13. |
| **Which factions** | Every one the data offers a booster for, warrants included, whatever the character's current standing. |
| **Surface** | CLI only. Dry run by default; `--out` writes a copy, `--commit` replaces the save. |
| **Undo** | The Stage 9 backup, and `--clear`. |

## The find that made it small

The effect is **already a field in the save**. `readBlock13` has always read
`positiveBoost` and `negativeBoost` per faction slot, and on `_Suchka` the eight
factions that have had a Writ used read exactly `1.5` while `negativeBoost` is
`0` everywhere. So there was never an item to grant: no inventory encoder, no
grid placement, nothing to right-click in game. Block 13 is 670 bytes and was
already fully decoded (Stage 9 decoded all fifteen blocks), so the edit rides
the transcript machinery unchanged.

## The multipliers are data

`db.factionBoosters()` reads `boostedFaction` and `boostedMultiplier` off the 42
records and the template `Class` says which field each sets. The target is the
**largest** multiplier offered per faction per direction, because the Mandate's
own description says it *"does not stack with Writs"* — a booster's value
replaces rather than adds, so "all of them" means the best of them. Nothing is
hardcoded to 3, and a patch adding a fourth tier is picked up by the same rule.

`vendorItems()` could not serve here: the twelve Warrants carry no vendor entry
at all. The accessor is an in-memory scan of the item index keyed on `DbItem.slot`
(the template class), so **the cached database needs no new field and no rebuild**.

## Faction key → save slot

Booster records name their faction the way `gamefactions.dbr` does — `Survivors`,
`Beasts`, `User8` — which is the identity `factions.ts` already maps the other
way. `factionSlotByKey` is that module's documented rule read backwards
(`User<N>` → `N + 6`, else one of the eight fixed slugs) and nothing new is
guessed.

It is *checkable*, and the test checks it: for the thirty Writs and Mandates the
resolved slot's `FactionSlot.id` must equal the item's own vendor `factionId` —
`User7` → slot 13 → `f7`, `User0` → slot 6 → `drifters`. Thirty independent
confirmations of a slot table that was derived from two saves.

## Deliverables

- `src/core/db/types.ts` / `index.ts` — `DbFactionBooster`, `GameDb.factionBoosters()`.
- `src/core/save/factions.ts` — `factionSlotByKey`.
- `src/core/save/gdc.ts` — `encodeBlock13`; `readBlock13` keeps the faction
  selection word it used to discard (`CharacterSave.factionSelection`), because
  an encoder cannot reproduce a field the parser threw away.
- `src/core/save/edit.ts` — `SaveEditRefusal` + `saveEditRefusals`, lifted out of
  `mastery.ts`: the six refusals that are about the *file* rather than the
  operation, now shared by both edits along with their wording.
- `src/core/save/boosters.ts` — `planFactionBoosters`, `bestBoosters`.
- CLI `boosters`.

## Acceptance criteria

- [x] All 42 boosters found; 15 Writs at ×1.5, 15 Mandates at ×3, 12 Warrants at ×3.
- [x] Every writ-line faction key resolves to the slot its own vendor names (30/30).
- [x] `encodeBlock13` is a structural prefix of what was recorded, both characters.
- [x] `_Suchka`: 27 changes over 23 slots, the edited buffer re-parses with no
      warnings and all fifteen checksums, and a field-by-field diff shows **only**
      `positiveBoost`/`negativeBoost` moving — reputation values, unlock and
      changed flags, and every other block untouched.
- [x] Idempotent: the second run reports 27 unchanged, 0 changes, and no output.
- [x] `--clear` zeroes both fields, the already-used Writs' `1.5`s included.
- [x] `--no-writs` / `--no-warrants` / `--faction` filter; an unmatched
      `--faction` is a refusal, not a silent empty plan.
- [ ] **Load the edited character in Grim Dawn.** Stage 9's open item, and this
      is the right edit to open with: two floats per faction, no header change,
      no block that changes length.

## Verification

```bash
npm test
npm run typecheck
npm run cli -- boosters --char _Suchka                    # the plan; writes nothing
npm run cli -- boosters --char _Suchka --out /tmp/b.gdc
npm run cli -- parse /tmp/b.gdc                           # 15 blocks, 15 verified
npm run cli -- boosters --char _Suchka --commit           # with Grim Dawn quit
```

## Outcome

Shipped as planned; the design got *smaller* than the plan on the way in, twice.
The booster table needed no cache field (a scan over the item index answers it,
so no schema bump and no rebuild), and the plan's `skipped` list has stayed empty
on the live data — every one of the 42 records maps to a slot this save has.

The four factions the game lets you side against — Kymon's Chosen, the Order of
Death's Vigil, the Outcast, Barrowholm — carry **both** a writ line and a
warrant, and land on one slot with both directions filled, which is why
`bestBoosters` groups by slot rather than by the record's faction key. The
command states the consequence rather than deciding it: a warrant multiplies
reputation *lost*, so on a faction you are friendly with it also triples what a
wrong choice costs.

The refusal refactor was worth doing for its own sake: `mastery.ts` had six
refusal kinds that were never about masteries, and the CLI held their wording.
Both now live in `edit.ts`, so the second edit command inherited every check —
checksums, resyncs, opaque regions, the byte-identical round trip and the
changed-on-disk guard — without restating one of them.

## Follow-up: Custom Game characters

Asked for right after the stage landed, and scoped to the boosters alone — a
custom game's items come from a mod's database and this tool reads the installed
game's, so nothing else should cross the boundary.

`save/user/<char>` is what the game's Custom Game mode writes (the mod's own
account-wide stashes sit beside the campaign's, in `save/<mod>/`). The two trees
are independent namespaces and **a name can live in both** — this machine has a
`_Suchka` in each — so `characterSavePath` and `listCharacters` took a `SaveTree`
parameter that **defaults to `main`**, leaving every existing caller on the
campaign. `--custom` selects the other tree, a name found in the wrong one says
so (`"_abcdef" is a campaign character — drop --custom`), and backups go under
`backups/user/<char>` so a shared name cannot offer the wrong file to restore.

The interesting part was not the tree. The custom character **refused** the edit
with one `opaque` byte in block 16 — and the refusal was right. Block 16 carries
a **skills map**, and it is empty on every campaign character, so `19 words + a
zero count + the two endless-dungeon currencies` reads identically to the 22
blind words the decoder had. A mod character fills it (one entry,
`records/skills/playerclassmonk/blinding_flash.dbr`), the blind read walks into
the string, and every field after it decodes at the wrong width — while the block
still checksums, because the trailing drain swallows the difference. The single
leftover byte at the end of the block was the only visible symptom, and since
block 16 sits *after* block 13, `replay` refused rather than corrupting it.

That is the transcript design paying for itself: the failure mode it was built
to make impossible showed up on the first save from outside the sample it was
written against, and it showed up as a refusal rather than as a save the game
would not load. The layout is now
`19 u32 · count · count × (record string, u32) · 2 u32 · 1 byte · drain`, all
four live saves replay byte-for-byte with zero opaque segments, and the custom
character takes the same 27 changes.
