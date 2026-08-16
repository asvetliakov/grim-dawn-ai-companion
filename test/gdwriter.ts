/**
 * Synthetic-save helpers for the tests.
 *
 * The cipher's encoder used to live here; it became production code when the
 * tool learned to write a save back (Stage 9), so it now lives in
 * `src/core/save/writer.ts` and is re-exported for the existing call sites.
 * What stays here is the fixture-building on top of it: blocks with a fixed
 * payload, and the item struct as 1.3.0.6 writes it.
 */

import { GdWriter } from '../src/core/save/writer.js';

export { GdWriter } from '../src/core/save/writer.js';
export type { WriterBlock } from '../src/core/save/writer.js';

/** A fixed-payload block: id, length, body of `payload` words, trailing checksum. */
export function synthBlock(w: GdWriter, id: number, payload: number[], corrupt = false): void {
  w.writeU32(id);
  w.writeLengthNoAdvance(payload.length * 4);
  for (const v of payload) w.writeU32(v);
  w.writeChecksum(corrupt);
}

/**
 * The 18-field item struct as 1.3.0.6 writes it. Only the fields a test cares
 * about are parameterized; the rest are zero, which is what real saves hold.
 */
export function writeItem(
  w: GdWriter,
  { baseName, stackCount = 1, seed = 0 }: { baseName: string; stackCount?: number; seed?: number },
): void {
  w.writeStr(baseName);
  w.writeStr(''); // prefix
  w.writeStr(''); // suffix
  w.writeStr(''); // modifier
  w.writeStr(''); // transmute
  w.writeU32(seed);
  w.writeStr(''); // relic (component)
  w.writeStr(''); // relic bonus
  w.writeU32(0); // relic seed
  w.writeStr(''); // augment
  w.writeU32(0); // unknown
  w.writeU32(0); // augment seed
  w.writeU32(0); // relic completion level
  w.writeU32(0); // unknownExtra[0]
  w.writeU32(0); // unknownExtra[1]
  w.writeU32(stackCount);
  w.writeU32(0); // unknownExtra[2]
  w.writeU32(0); // unknownExtra[3]
}
