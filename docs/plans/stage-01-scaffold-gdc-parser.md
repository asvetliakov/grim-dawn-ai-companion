# Stage 1 — Scaffold + player.gdc parser

## Goal

Create the project scaffold and a TypeScript parser for Grim Dawn character saves (`player.gdc`), proven correct by block checksums against the two real characters on this machine. Expose it via a dev CLI `parse` command.

## Context

Greenfield repo. This is the foundation stage: the cipher/reader built here (`GdReader`) is reused verbatim by Stage 2 (stash files). No JS/TS parser for this format exists publicly — we port from specs:

- Primary reference: **gd-explorer** (Haskell, BSD-3) — https://github.com/xaviershay/gd-explorer, esp. its `PLAN.md` format spec (cipher appendix, block framing, item structs).
- Cross-check (spec only, EPL-licensed — do not copy code): **gd-edit** `src/gd_edit/io/gdc.clj` — https://github.com/Odie/gd-edit — the most complete field-by-field block enumeration.

Test fixtures (real saves, read in place; game is v1.3.0.6):

```
~/Library/Application Support/CrossOver/Bottles/Steam/drive_c/Program Files (x86)/Steam/userdata/42909985/219990/remote/save/main/_Suchka/player.gdc
~/Library/Application Support/CrossOver/Bottles/Steam/drive_c/Program Files (x86)/Steam/userdata/42909985/219990/remote/save/main/_abcdef/player.gdc
```

Note: the parsers we port from were written against ~1.2 saves; these are 1.3.0.6. Checksums will immediately reveal any structural drift — if a block fails, isolate which field changed by comparing both saves, and prefer version-gated reads (warn, don't throw).

## Format spec

### Cipher (seeded XOR stream)

1. Read the file's first 4 bytes as u32 LE. `seed = raw XOR 0x55555555`.
2. Build a 256-entry u32 table: `v = seed`; repeat 256×: `v = ((v << 31) | (v >>> 1)) * 39916801`, all mod 2^32; `table[i] = v`.
3. Maintain `state` (u32), initialized to `seed`.
4. **Read u32**: `plain = cipher XOR state`; then for each of the 4 **ciphertext** bytes (LE order): `state ^= table[byte]`.
5. **Read byte**: `plain = cipher XOR (state & 0xFF)`; then `state ^= table[cipherByte]`.
6. **Read float**: read u32, reinterpret bits as IEEE-754 (DataView).
7. **Read string**: u32 length, then N bytes (ASCII); wide string: length then N×2 bytes UTF-16LE. State advances per ciphertext byte in file order.

Critical: state advances over **ciphertext**, never plaintext. Use `>>>` / `Math.imul` for correct u32 arithmetic in JS.

### Block framing

- Block ID: u32 read normally (advances state).
- Length: raw u32 XOR current state — **consumed but state does NOT advance**.
- Body: `length` bytes of payload (reads advance state as usual).
- Trailing checksum: raw u32, consumed without advancing; **must equal the current state**.

Consequences: (a) a passing checksum proves the block was consumed exactly; (b) unknown block IDs are skippable by cipher-advancing over the body bytes without decoding — never fail on unknown blocks, log and skip (forward compat with 1.3.x patches).

### File layout

Header (through the cipher): magic `"GDCX"` (u32) → version → character name (wide string) → sex byte → class-record string (ASCII) → level (i32) → hardcore byte → expansion byte → header checksum. Then a data version u32 (expect 6/7/8 — warn on other values, don't throw) and a 16-byte unknown field. Then blocks until EOF.

Blocks to parse (skip all others generically):

| ID | Contents |
|---|---|
| 1 | Quest/progression flags incl. **current difficulty**, iron (money), tributes; v2+: weapon-set config |
| 2 | Bio: level, XP, attribute/skill/devotion points, physique/cunning/spirit/health/energy (floats) |
| 3 | **Inventory**: N sacks (items with X/Y as **i32**), 12 equipment slots + `attached` bool each, 2 alternate weapon sets |
| 4 | **Personal stash**: tabs with width/height, items with X/Y i32 |
| 8 | **Skills**: array of {record, level, enabled, devotion fields}, item-skill bindings, mastery/reclaimed points; v6+: extra unknown i32 |
| 13 | **Faction reputation**: `factionSelection` i32, then array of {changed u8, unlocked u8, value f32, positiveBoost f32, negativeBoost f32}. **Array index = faction id** (no names in save) |
| 16 | Play stats: playtime, deaths, kills, crafting counts; v11+: extra skill map + endless counters |

Faction tier mapping from `value`: Friendly ≥1501, Respected ≥5001, Honored ≥10001, Revered ≥25000; else Neutral (negative = hostile tiers, can lump as "Hostile").

Item struct (used by blocks 3 and 4; same struct reappears in Stage 2's stash):
`baseName`, `prefixName`, `suffixName`, `modifierName`, `transmuteName` (ASCII strings — DBR record paths), `seed` (u32), `relicName`, `relicBonus`, `relicSeed`, `augmentName`, unknown u32, `augmentSeed`, `relicCompletionLevel` (u32), `stackCount` (u32). Positional wrappers: inventory/stash items add X/Y **i32**; equipment items add an `attached` bool instead. If field order proves off on the 1.3 saves, gd-explorer's PLAN.md item struct is authoritative; validate with checksums.

Faction index→name table (hardcode in `src/core/save/factions.ts`; verify indices empirically against _Suchka, who has known reputations — spot-check via in-game faction window if ambiguous): index 0 = Devil's Crossing; the rest follow the game's internal order (Aetherials, Chthonians, Cronley's Gang, …, Rovers, Homestead, Kymon's Chosen, Order of Death's Vigil, Black Legion, Outcast, Malmouth Resistance, Coven of Ugdenbog, Barrowholm, Cult of Bysmiel/Dreeg/Solael, …). Mark uncertain entries with `?` in the table and refine in Stage 5 when names matter; only `unlocked` + tier are needed before then.

## Deliverables

```
package.json          # "type": "module"; scripts: cli (tsx src/cli/index.ts), test (vitest run), typecheck (tsc --noEmit)
tsconfig.json         # strict, ES2023, moduleResolution bundler (or nodenext)
src/core/save/cipher.ts   # GdReader
src/core/save/gdc.ts      # parseGdc(buf): CharacterSave
src/core/save/types.ts    # CharacterSave, ItemInstance, FactionRep, EquipSlot enum
src/core/save/factions.ts # faction index→name table
src/cli/index.ts          # commander; `parse <path>` command
test/save.test.ts
test/paths.ts             # resolves live save dir (env GD_SAVE_DIR override → default userdata path above)
```

Dependencies: `commander`, dev: `typescript@^5.9`, `tsx`, `vitest`, `@types/node`.

`GdReader` sketch:

```ts
class GdReader {
  constructor(buf: Buffer)
  readU32(): number
  readFloat(): number
  readByte(): number
  readStr(): string
  readWStr(): string
  beginBlock(): { id: number; length: number }
  endBlock(): void            // throws ChecksumError if trailing u32 !== state
  skipBlockBody(length: number): void   // advances state without decoding
  get offset(): number; get eof(): boolean
}
```

`CharacterSave` must include: name, classRecord, level, hardcore, difficulty, iron, attributes (physique/cunning/spirit/health/energy + unspent points), skills `{record, level}[]`, devotion list, equipment `(ItemInstance|null)[]` (12 + 2 swap), inventorySacks `ItemInstance[][]`, personalStash `ItemInstance[][]`, factions `FactionRep[]` (id, name?, unlocked, value, tier), playStats (playTime, deaths).

CLI `parse` output: character summary (name, level, class record(s), difficulty, hardcore, iron), attribute lines, faction table (unlocked ones with value + tier), counts (equipped/inventory/stash items, skills), and a per-block line `block <id>: ok (checksum)` / `block <id>: skipped (unknown)`.

## Acceptance criteria

1. `npm run cli -- parse "<save dir>/main/_Suchka/player.gdc"` and same for `_abcdef`: **every block checksum passes** (parsed and skipped blocks alike); no thrown errors.
2. Output shows plausible values: _Suchka is a leveled character with Ultimate unlocked (difficulty field consistent), non-zero iron, multiple unlocked factions with sensible tiers, 12-slot equipment mostly filled.
3. `npm test` green: unit tests for the cipher (decrypt first bytes → magic `"GDCX"`), block framing round-trip on a synthetic buffer, and a live-file test (skipped with a clear message if `GD_SAVE_DIR` doesn't exist).
4. `npm run typecheck` clean.
5. Unknown blocks are logged and skipped, not fatal; unexpected data version prints a warning, not an error.

## Verification

```bash
npm test && npm run typecheck
npm run cli -- parse "$HOME/Library/Application Support/CrossOver/Bottles/Steam/drive_c/Program Files (x86)/Steam/userdata/42909985/219990/remote/save/main/_Suchka/player.gdc"
npm run cli -- parse "$HOME/.../main/_abcdef/player.gdc"   # same base path
```

## Outcome

Done. Both real saves parse with **every block checksum passing** (15 blocks each,
15/15 verified, zero warnings) and `npm test` / `npm run typecheck` are green.

The 1.2-era specs the plan cites were right about the cipher and the framing but
wrong about several 1.3.0.6 structures. What actually differs, all of it settled
by checksum rather than by argument:

- **Unknown blocks are not blind-skippable.** Blocks 3 and 4 contain *nested*
  blocks, whose length and checksum words are read without advancing the cipher;
  advancing over them desynchronizes everything downstream. Fixed exactly, not
  heuristically: a block's trailing checksum *is* the writer's post-block cipher
  state, so `GdReader.skipBlockAndResync` adopts it and resynchronizes perfectly
  regardless of what the body held. This is what makes forward compat real —
  a future patch can add nested-block-bearing blocks and we still parse the rest.
- **Item struct is 18 fields, not 14.** Two extra words sit between
  `relicCompletionLevel` and `stackCount`, two more after it. All four are zero
  across every item on both characters, so their meaning is unknown (they may be
  empty strings, which reads identically while empty). `stackCount` was pinned by
  landing on real stack sizes (13 scavenged plating, 9 cracked lodestone, 1 for gear).
- **Personal stash uses float X/Y**, not i32. The plan's gotcha ("`player.gdc`
  inventory/stash X/Y are i32") holds for inventory sacks only — block 4's stash
  tabs store floats, like `transfer.gst`. Worth carrying into Stage 2.
- **Stash tabs have a 20-byte trailer** (five zero words) after their item list.
- **Skill entries pad each bool to two bytes** — one extra zero byte after
  `enabled` and after `active`, making the scalar payload 28 bytes.
- **Block versions**: blocks 3 and 4 report version 11 (not 4/5/6); block 1 is 5,
  block 2 and 8 are 8. Header v2, data v8.
- **Block 1 tail** is a 42-entry loot-filter byte array after an empty
  `playerTexture` string, which is what makes the block exactly 71 bytes.

Deliberately *not* modelled, to avoid shipping unverifiable guesses:

- **Item-granted skills.** Block 8 ends with five words: `masteriesAllowed`,
  `skillReclamationPointsUsed`, `devotionReclamationPointsUsed` (all decoded, all
  plausible — 2 / 29 / 2 for _Suchka, 2 / 0 / 0 for _abcdef), then two zero words.
  One is probably the item-skill count, but with no non-empty sample on either
  character a guess would parse silently and wrongly. Left undecoded.
- **Block 16's tail.** Only `playTime`, `deaths`, `kills` are identified; the rest
  of the play-stats block grows per patch and is walked-and-checksummed, not modelled.

Corrections to the plan's own assumptions:

- **Equipment slot 11 is the relic, not a weapon**, and slots 9/10 are
  Shoulders/Medal (the plan's table order had them swapped). Weapons live only in
  the alternate weapon sets. Confirmed by matching each slot against the item
  category of the record it held on a fully-geared character.
- **Faction index 0 is a locked placeholder**, so the array is 1-based; the plan
  said index 0 = Devil's Crossing. Index 1 carries the Devil's-Crossing-shaped
  value on both characters.

**Open for Stage 5 — the faction name table is unverified past index 4.** The
guessed ordering puts both Kymon's Chosen and Order of Death's Vigil at Honored on
_Suchka, which the game makes mutually exclusive, so the ordering is wrong
somewhere. Every guessed name is `?`-suffixed and unconfirmed slots render as
`faction N`. Only `unlocked` + `tier` are relied on, which is all Stage 5 needs
before vendor augments matter. Resolving this needs either an in-game spot-check
or the DBR faction records.

**Unexplained observation:** both characters report difficulty 2 (Ultimate) for
current *and* greatest-completed, including _abcdef at level 25 with 51 minutes
played and one faction unlocked. The byte positions are certain (the block
checksums), so this is a semantics question, not a parse error — plausibly a
Merit unlock (both characters have Crucible map folders), but not confirmed.
