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
