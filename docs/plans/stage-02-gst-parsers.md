# Stage 2 — GST parsers (transfer stash + blueprints)

## Goal

Parse the shared transfer stash (`transfer.gst`) and the learned-blueprints file (`formulas.gst`) using the Stage 1 cipher, exposed via CLI `stash` and `formulas` commands.

## Context

Stage 1 delivered `GdReader` (seeded XOR stream cipher with block framing + checksums) in `src/core/save/cipher.ts` and the `ItemInstance` struct in `src/core/save/types.ts`. Both files here share that cipher but have **different framing than player.gdc** — do not reuse the gdc top-level reader.

Live fixtures (softcore; no `.gsh` hardcore files exist on this machine):

```
~/Library/Application Support/CrossOver/Bottles/Steam/drive_c/Program Files (x86)/Steam/userdata/42909985/219990/remote/save/transfer.gst
~/Library/Application Support/CrossOver/Bottles/Steam/drive_c/Program Files (x86)/Steam/userdata/42909985/219990/remote/save/formulas.gst
```

Reference: gd-explorer (https://github.com/xaviershay/gd-explorer) `PLAN.md` + its stash module; cross-check gd-edit `src/gd_edit/io/stash.clj` (spec only, EPL).

## Format spec

### transfer.gst

- Same cipher init as gdc (seed = first u32 XOR 0x55555555).
- After seed: a u32 that must decrypt to **`2`** (magic — not "GDCX").
- Then a single **block 18** (standard framing: id, length-no-advance, body, checksum==state) containing:
  - `version` (u32)
  - one u32 read with the current state **without advancing it** (quirk; consume raw)
  - `mod` (ASCII string, empty for vanilla)
  - expansion-status byte
  - sack count (u32), then sacks: each `width` u32, `height` u32, item count u32, items.
- Stash items = the Stage 1 `ItemInstance` struct **but X/Y are floats** (player.gdc uses i32). This is the classic porting bug — round to int for display.

File-extension notes (for the settings/glob layer, not this parser): `.gst` = softcore (Forgotten Gods+ era), `.gsh` = hardcore, rotating backups `transfer.t00`/`.h00`; older saves may be `.bst`/`.cst`. Glob rather than hardcode. Only `.gst` needs to work now.

### formulas.gst

Same cipher; account-wide learned blueprints (per mode). Structure mirrors the stash container (magic/version/framing per gd-explorer's formulas reader): yields a list of **blueprint DBR record paths** (`records/items/.../recipes/...dbr`-style strings), possibly with a small per-entry flag. Port from gd-explorer's implementation; checksums validate. Output model: `{ formulas: string[] }`.

## Deliverables

```
src/core/save/gst.ts    # parseTransferStash(buf): TransferStash; parseFormulas(buf): string[]
                        # TransferStash = { mod: string; sacks: { width; height; items: ItemInstance[] }[] }
src/cli/index.ts        # add `stash [path]` and `formulas [path]` (default paths from test/paths.ts logic)
test/gst.test.ts
```

## Acceptance criteria

1. `npm run cli -- stash` parses the live `transfer.gst`: checksum passes, prints sack count, per-sack dimensions and items (record paths + stack counts + rounded X/Y).
2. `npm run cli -- formulas` parses the live `formulas.gst`: checksum passes, prints blueprint count and first ~10 record paths (should look like plausible `records/...` paths).
3. `npm test` green (incl. float-X/Y handling unit-tested on a synthetic buffer); `npm run typecheck` clean.
4. Missing file → clear error message, not a stack trace.

## Verification

```bash
npm test && npm run typecheck
npm run cli -- stash
npm run cli -- formulas
```

## Outcome

Done. All four acceptance criteria pass; 28 tests green, typecheck clean. The live
`transfer.gst` parses with its single block 18 checksum-verified and no warnings
(2 sacks of 10×19, 47 items); `formulas.gst` yields 231 blueprint records.

### Deviations from the spec above

Two of this plan's format claims were wrong against the live 1.3.0.6 files. Both
were found the intended way — by the checksum refusing to match — and corrected:

1. **`transfer.gst` sacks are nested blocks, not inline structs.** The spec said
   each sack is `width`/`height`/`itemCount`/items laid out directly in block 18.
   In reality each sack is a nested block (id 0) with its own length and checksum,
   exactly like `player.gdc`'s personal-stash tabs, and carries the same **five
   trailing zero words** after its items. Consequence: block 18 can never be
   blind-skipped, which is why `skipBlockAndResync` matters here too.
   The rest of the header spec held: magic `2`, the non-advancing quirk word after
   `version`, then mod string and expansion byte.
   `version` is **11** on 1.3.0.6 (the plan implied a 4/5-era value).

2. **`formulas.gst` is not enciphered and has no checksums.** The plan assumed it
   shares the cipher and block framing. It does not: it is a plaintext key/value
   stream — `begin_block`/`0xb01dface` … `end_block`/`0xdeadc0de` — with values
   typed by key (`formulasVersion` u32, `numEntries` u32, `expansionStatus` byte,
   then `numEntries` × [`itemName` string, `formulaRead` u32]). Since values carry
   no length of their own, an unrecognised key is unskippable, so the parser
   throws on one rather than returning a list that merely *looks* complete.
   Integrity checking is structural instead of cryptographic: the file must close
   with `end_block` and its own `numEntries` must match what was read; both
   become warnings.

### Incidental refactors

- `src/core/save/blocks.ts` (new) — the "decode, and let the checksum arbitrate"
  block driver plus `finishNested`, lifted out of `gdc.ts` so both parsers share
  one copy. `gdc.ts` behaviour is unchanged (Stage 1 tests still pass untouched).
- `src/core/paths.ts` (new) — save-directory resolution (`GD_SAVE_DIR`-aware) now
  lives in core, so the CLI's default arguments and `test/paths.ts` use the same
  lookup instead of two copies. Stage 3's settings file replaces the default here.
- `test/gdwriter.ts` (new) — the cipher's encoder side, extracted from
  `save.test.ts` and extended with `writeFloat`, `beginBlock`/`endBlock`
  (back-patching lengths) and `writeItem`, which is what makes a synthetic stash
  buildable.
- `GdReader.readU32NoAdvance` went from private to public for the stash header's
  quirk word.

### Notes for later stages

- `parseFormulas(buf): string[]` is the plan's signature; `parseFormulasFile`
  sits behind it and also returns version, expansion status and the per-blueprint
  `read` flag (unread blueprints show as `*` in the CLI listing).
- The save directory holds three more `.gst` files not covered by any stage:
  `reagents.gst`, `transmutes.gst`, `potions.gst`. Unexamined so far — worth a
  look if a later stage wants crafting-material or illusion data.
- Still no hardcore (`.gsh`) files on this machine, so that path stays untested.
