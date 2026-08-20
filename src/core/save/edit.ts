/**
 * The checks every save edit runs before it is allowed to write anything.
 *
 * They are about the *file*, not about the operation: a block that did not
 * checksum, a region whose field widths are unknown, or a transcript that
 * cannot even reproduce the bytes it came from. Removing a mastery and applying
 * a faction booster ask exactly the same questions here, and both refuse rather
 * than repair — a plan carrying any refusal is not written.
 *
 * `roundtrip-mismatch` is the strongest of them and the cheapest: it says we
 * could not re-encipher the unedited save into the file we just read, so
 * nothing we produce from it can be trusted.
 */

import { opaqueBlocks, replay, type Transcript } from './transcript.js';
import type { CharacterSave } from './types.js';

export type SaveEditRefusal =
  | { kind: 'block-checksum'; blockId: number }
  | { kind: 'resynced-block'; blockId: number }
  | { kind: 'opaque-block'; blockIds: number[] }
  | { kind: 'roundtrip-mismatch'; offset: number }
  | { kind: 'encoder-prefix-mismatch'; detail: string }
  | { kind: 'save-changed-on-disk' };

/**
 * Everything standing in the way of writing this save back, in the order a
 * reader wants them: what the parse already knew, then the round trip.
 */
export function saveEditRefusals(save: CharacterSave, transcript: Transcript, source: Buffer): SaveEditRefusal[] {
  const refusals: SaveEditRefusal[] = [];
  for (const block of save.blocks) {
    if (!block.checksumOk) refusals.push({ kind: 'block-checksum', blockId: block.id });
  }
  for (const blockId of transcript.resynced) refusals.push({ kind: 'resynced-block', blockId });
  const opaque = [...new Set(opaqueBlocks(transcript))];
  if (opaque.length) refusals.push({ kind: 'opaque-block', blockIds: opaque });

  const verbatim = replay(transcript);
  if (!verbatim.equals(source)) {
    refusals.push({ kind: 'roundtrip-mismatch', offset: firstDifference(verbatim, source) });
  }
  return refusals;
}

export function firstDifference(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

/** Human wording for a refusal, shared by every command that can hit one. */
export function saveEditRefusalText(r: SaveEditRefusal): string {
  switch (r.kind) {
    case 'block-checksum':
      return `block ${r.blockId} does not checksum — this save is damaged or half-written`;
    case 'resynced-block':
      return `block ${r.blockId} had to be resynced, so the file cannot be rebuilt exactly`;
    case 'opaque-block':
      return `block(s) ${r.blockIds.join(', ')} are not decoded; re-encoding them would corrupt them`;
    case 'roundtrip-mismatch':
      return `this build cannot reproduce the save byte-for-byte (first difference at ${r.offset}) — refusing to edit it`;
    case 'encoder-prefix-mismatch':
      return `a block encoder disagrees with the file: ${r.detail}`;
    case 'save-changed-on-disk':
      return 'the save changed on disk while this ran — is the game running?';
  }
}
