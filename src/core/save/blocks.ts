/**
 * The generic "decode a block, then let the checksum arbitrate" driver, shared
 * by the `.gdc` character parser and the `.gst` stash parser.
 *
 * Every block ends on a word equal to the writer's cipher state, so a block
 * that checksums is a block we consumed byte-for-byte correctly. That makes the
 * file, not the spec, the authority: a decoder that disagrees is rolled back
 * and the block is skipped rather than half-trusted.
 */

import type { GdReader, BlockStart } from './cipher.js';
import type { BlockReport } from './types.js';

export function parseBlock(
  r: GdReader,
  block: BlockStart,
  decode: ((r: GdReader, block: BlockStart) => void) | undefined,
  warn: (msg: string) => void,
): BlockReport {
  const start = r.mark();

  if (decode) {
    try {
      decode(r, block);
      if (r.offset > block.bodyEnd) {
        throw new Error(`overran block body by ${r.offset - block.bodyEnd} byte(s)`);
      }
      // Trailing bytes we chose not to decode (e.g. a patch-grown tail) still
      // have to advance the cipher before the checksum can be checked.
      if (r.offset < block.bodyEnd) r.skipBlockBody(block.bodyEnd - r.offset, block.id);
      r.endBlock(block);
      return { id: block.id, length: block.length, status: 'parsed', checksumOk: true };
    } catch (err) {
      warn(`block ${block.id}: decode failed, skipping (${(err as Error).message})`);
      r.reset(start);
    }
  }

  // Unknown or undecodable: try a plain skip first, which still verifies the
  // checksum and so proves the block had no nested sub-blocks.
  try {
    r.skipBlockBody(block.length, block.id);
    r.endBlock(block);
    return {
      id: block.id,
      length: block.length,
      status: 'skipped',
      checksumOk: true,
      note: decode ? 'decode failed' : 'unknown block id',
    };
  } catch {
    // Contains nested blocks: resync exactly from the trailing checksum.
    r.reset(start);
    r.skipBlockAndResync(block);
    return {
      id: block.id,
      length: block.length,
      status: 'skipped',
      checksumOk: false,
      note: 'nested blocks; resynced from checksum',
    };
  }
}

/**
 * Consume whatever is left of a nested block and verify its checksum. Trailing
 * fields we do not model (the game adds them per patch) are absorbed here rather
 * than guessed at, and the checksum still proves the block was walked correctly.
 */
export function finishNested(
  r: GdReader,
  block: BlockStart,
  warn: (msg: string) => void,
  label: string,
): void {
  const left = block.bodyEnd - r.offset;
  if (left < 0) throw new Error(`${label}: overran nested block by ${-left} byte(s)`);
  if (left > 0) {
    warn(`${label}: ${left} undecoded trailing byte(s)`);
    r.skipBlockBody(left, block.id);
  }
  r.endBlock(block);
}
