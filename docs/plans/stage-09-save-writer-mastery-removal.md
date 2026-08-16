# Stage 9 — Save writing, and removing a mastery

## Goal

Grim Dawn refunds every point you spent in a mastery and then keeps the mastery:
the last point in the bar cannot be taken back, and a second mastery cannot be
swapped for another. The only way out is to edit `player.gdc`.

This stage gives the tool its first write path — a save writer that is safe by
construction — and one narrow operation on top of it: `remove-mastery`.

Scope, decided with the user before any code:

| | |
|---|---|
| **Scope** | Refuse unless the mastery is already reset to the bar alone at rank 1. |
| **Surface** | CLI only. Dry run by default; `--out` writes a copy, `--commit` replaces the save. |
| **Safety** | Timestamped backup kept forever, temp file + `rename` for the write. |

## The constraint that shapes everything

The cipher state advances over ciphertext, so **one changed byte re-enciphers
the whole remainder of the file**. That much was expected. The trap is subtler:
*the same ciphertext decodes differently depending on the width it is read at*.
`readU32` xors the whole 32-bit state; four `readByte`s xor `state & 0xff` and
advance in between.

Probed directly against `GdReader`/`GdWriter` before anything was designed:

```
payload captured bytewise:                        ef7759c4
replayed after an upstream edit, re-read as u32:  9c9eb8ef   (want deadbeef)
replayed with no upstream edit:  byte-identical, payload reads deadbeef
```

Three consequences, and they kill the obvious designs:

1. Capturing an undecoded block as plaintext bytes and re-enciphering it is
   **silent corruption** of every u32, float and string length inside it — and
   the checksum still passes, because both widths advance over the same bytes.
2. A **byte-identical no-op round trip proves nothing about edits**. Necessary,
   and badly misleading on its own.
3. "This skipped block contains no non-advancing words" is true and irrelevant.
   The hazard is unknown *field widths*.

So every byte downstream of the earliest edit must be decoded at its true width.
Since the class tag lives in the header — the first thing in the file — that
means **all fifteen blocks**, which is why this stage decodes eight blocks the
rest of the app has no use for.

## Design: a transcript, with unknown widths as a typed refusal

`src/core/save/transcript.ts`. Parsing records what was read, at the width it
was read; `replay` re-enciphers, recomputing every block length and checksum
from the new state. Edits are a splice.

The idea that makes it safe is two segment kinds for plaintext bytes:

- `u8` — bytes a decoder *chose* to read as bytes. Width-known, replays at any state.
- `opaque` — what `skipBlockBody` hands back. Width-**unknown**.

`replay` throws `OpaqueRegionError` the moment it meets an `opaque` (or a `raw`
resynced block) *after* an edit. The corruption above becomes a mechanical
refusal, and "how much is left to decode" becomes a test that counts opaque
segments rather than a judgement call.

`spliceRegion` is the second guard: it encodes the **unedited** save and
requires that to be a structural prefix of what was actually read, before the
edited encoding replaces it. An encoder that has drifted from its decoder throws
instead of writing a plausible-looking wrong file. This is why `encodeHeader`,
`encodeBlock2` and `encodeBlock8` live in `gdc.ts` beside the decoders they
mirror.

## How the widths were established

A wrong width is invisible to the checksum and invisible to a decode/re-encode
identity test, which is self-consistent by construction. Three oracles did it:

- **Cross-state agreement.** Decode the same content at two points whose cipher
  state differs; only the right width makes them agree. Block 5's "current
  respawn" UIDs are members of its own respawn list at byte width and not at
  word width; all 72 of block 6's riftgate UIDs are identical across the two
  test characters at byte width and none at word width.
- **The low-byte trick.** The first byte of a u32 always decodes bytewise to
  that u32's true low byte, because it uses the same state. So a bytewise dump
  reveals every string length word and every `0`/`-1` field, which pins the
  alignment. This is what unpicked block 14.
- **Exact consumption on both characters**, and internal agreement — block 16's
  `loreNotesCollected` is 238 and 4, exactly the lengths of block 12's lists.

Structures found (all consume exactly, on both characters):

| Block | Structure |
|---|---|
| 5, 6, 7 | `u32 ver` + 3 × (`u32 n` + n × 16 **bytes** of UID); block 5 has 3 more UIDs |
| 17 | the same with **six** lists, not three |
| 12, 10 | `u32 ver`, `u32 n`, n × `str`, then any trailing words |
| 15 | `u32 ver`, `u32 n`, n × `u32` |
| 14 | header, 5 × skill set, 3 × `u32`, then **46** hot slots — a leading kind word, `-1` empty, `2`/`3` the potion slots, `0` a skill with `str`/`bool`/`str`/`i32` — then `u32` + camera distance |
| 16 | `u32 ver`, 12 words, 3 × greatest-monster-killed, 22 words, a byte, trailing words |
| 8 tail | two genuine `u32` zeros (at byte width they decode to `0,111,113,0,…`) |

Two corrections to what the parser believed:

- **Block 8's skills and devotions are interleaved in file order**, not grouped
  (`_Suchka`: 29 skills, 57 devotions, 42 skills). `CharacterSave.skillEntries`
  is the file's array; `skills`/`devotions` are views over it.
- **The byte after `enabled` is not padding.** It is 1 on exactly the 32 GDX3
  potion-modifier entries of both characters. Kept as `CharacterSkill.unknown1`.

## The operation

`src/core/save/mastery.ts`. Three regions change: the header's class tag, block
2's unspent skill points, block 8's skill list.

- Membership is decided by **record path** (`records/skills/playerclassNN/`),
  not by a database lookup: `build.ts` excludes pet subtrees, so the database
  answers `undefined` for skills a character really has invested in.
- The class tag is `tagSkillClassName` + the remaining class numbers, ascending
  (`tagSkillClassName0410` Reaver → `tagSkillClassName10` Berserker). Ten
  masteries exist on 1.3, `playerclass01`–`10`, with all 45 combinations.
- `masteriesAllowed` is left alone, so a replacement can be picked in game.
- Auto-cast bindings need no repair: a binding lives on the **host** skill and
  names a devotion, so removing a mastery takes its bindings with it. Checked
  anyway, and a non-empty result is a refusal — it would mean the model is wrong.
- The hotbar needs no repair either, for the same reason the scope gate exists:
  a mastery reset to its bar has no skills left to be on it.

Refusals, any of which stops the write: `block-checksum`, `resynced-block`,
`opaque-block`, `roundtrip-mismatch`, `encoder-prefix-mismatch`,
`unknown-mastery`, `last-mastery`, `mastery-not-reset`, `save-changed-on-disk`.
The strongest is `roundtrip-mismatch`: **`replay(transcript)` must equal the
file on disk byte for byte before a modified one may be written.** It costs a
millisecond and means we never write a file we could not already reproduce.

## Deliverables

- `src/core/save/writer.ts` — `GdWriter` promoted from `test/gdwriter.ts`, plus
  `writeBool`/`writeI32`/`writeWStr`/`writeRawCipher`/`writeTail`.
- `src/core/save/transcript.ts` — segments, `SegWriter`, `TranscriptRecorder`,
  `replay`, `opaqueBlocks`, `spliceRegion`.
- `src/core/save/cipher.ts` — an optional recorder; no behaviour change without one.
- `src/core/save/gdc.ts` — `parseGdcRecording`, decoders for blocks 5, 6, 7, 10,
  12, 14, 15, 17 and block 16's tail, `skillEntries`/`skillsTail`/`unknown1`,
  and the three encoders.
- `src/core/save/mastery.ts`, `src/core/save/write.ts`.
- CLI `masteries` and `remove-mastery`.

## Acceptance criteria

- [x] `replay` of a recorded live save is **byte-identical**, both characters.
- [x] **Zero opaque segments** and zero resyncs on both characters.
- [x] **Reseed round trip**: re-encipher under `seed ^ 0xffffffff`, re-parse,
      every `CharacterSave` field deep-equals and all 15 blocks checksum. This
      is the only test that exercises a total state shift.
- [x] `save.test.ts` requires every block to be decoded, not skipped.
- [x] The `deadbeef` state-dependence fact is a regression test, so nobody ever
      merges `u8` and `opaque` back into one kind.
- [x] `_Suchka` + Nightblade: 1 entry removed, +1 skill point, Reaver →
      Berserker, and the edited buffer re-parses with no warnings, all fifteen
      checksums, no `playerclass04` record, all 57 devotions, and a field-by-field
      diff against the original showing only the three intended changes.
- [x] Refusals: Berserker → `mastery-not-reset`; `_abcdef` → `last-mastery`;
      unknown name; a tampered source → `roundtrip-mismatch`.
- [ ] **Load the edited copy in Grim Dawn.** The one oracle no unit test
      replaces: it loads, the mastery is gone, the point is available, and
      riftgates / respawns / quest tokens / hotbar are intact. Then save in game
      and diff the game's own rewrite against our decode — a wrong field width
      shows up there and nowhere else.

## Verification

```bash
npm test                                                  # incl. transcript + mastery suites
npm run typecheck
npm run cli -- masteries      --char _Suchka
npm run cli -- remove-mastery --char _Suchka --mastery Nightblade            # dry run
npm run cli -- remove-mastery --char _Suchka --mastery Nightblade --out /tmp/x.gdc
npm run cli -- parse /tmp/x.gdc                           # 15 blocks, 15 verified
```

## Outcome

The transcript design was rewritten once before any code shipped: the first
sketch captured undecoded blocks as plaintext bytes, which the `deadbeef` probe
showed is silent corruption. The rewrite cost nothing but made the decoding job
bigger — every block had to be modelled rather than the five downstream of
block 8 — and it is the reason the `u8`/`opaque` split exists.

Decoding all fifteen blocks turned out to be a day's archaeology rather than the
open-ended job it looked like, because the low-byte trick makes a bytewise dump
readable. Block 14 was the only real fight.

Not done, deliberately: no UI. The user asked for the CLI first, and a control
that irreversibly edits a save wants the write path to have been used on a real
character before it gets a button.
