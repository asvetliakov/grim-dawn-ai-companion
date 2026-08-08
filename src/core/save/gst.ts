/**
 * Parsers for the two account-wide `.gst` files.
 *
 * Despite sharing an extension these are *two different formats*:
 *
 *  - `transfer.gst` (the shared transfer stash) uses the same seeded XOR cipher
 *    and checksummed block framing as `player.gdc`, but with its own top-level
 *    layout — magic `2` rather than "GDCX", and a single block 18.
 *  - `formulas.gst` (learned blueprints) is **not enciphered at all**: it is a
 *    plaintext key/value stream delimited by `begin_block`/`end_block` sentinel
 *    words, with no checksum anywhere. See `parseFormulas` below.
 *
 * Both were confirmed empirically against this machine's live 1.3.0.6 files.
 */

import { finishNested, parseBlock } from './blocks.js';
import { GdReader } from './cipher.js';
import { readItem } from './gdc.js';
import type { BlockReport, PositionedItem } from './types.js';

// ---------------------------------------------------------------------------
// transfer.gst — shared transfer stash
// ---------------------------------------------------------------------------

/** The transfer stash's magic word, in place of the character save's "GDCX". */
export const GST_MAGIC = 2;

/** The only top-level block the stash file contains. */
const STASH_BLOCK_ID = 18;

export interface StashSack {
  width: number;
  height: number;
  /** X/Y are floats in this file — see `readStashItem`. */
  items: PositionedItem[];
}

export interface TransferStash {
  /** Absolute path the stash was read from, when known. */
  path?: string;
  version: number;
  /** Mod name; empty for vanilla. */
  mod: string;
  expansionStatus: number;
  sacks: StashSack[];
  blocks: BlockReport[];
  /** Non-fatal problems: unknown blocks, unexpected versions. */
  warnings: string[];
}

/**
 * A stash item is the ordinary item struct followed by grid coordinates — but
 * stored as **floats** here, where `player.gdc`'s inventory sacks store them as
 * i32. Reading one as the other is the classic porting bug: it does not fail
 * loudly, it silently yields absurd coordinates and then desynchronizes nothing
 * (both are 4 bytes), so only the values look wrong.
 */
function readStashItem(r: GdReader): PositionedItem {
  const item = readItem(r);
  const x = r.readFloat();
  const y = r.readFloat();
  return { ...item, x, y };
}

function readStashBlock(r: GdReader, stash: TransferStash, warn: (msg: string) => void): void {
  stash.version = r.readU32();
  if (stash.version !== 11) warn(`stash block: unexpected version ${stash.version} (expected 11)`);

  // A quirk of this format: one word here is deciphered against the current
  // state but does *not* advance it, exactly like a block length word. Consume
  // it without advancing or every checksum downstream fails.
  r.readU32NoAdvance();

  stash.mod = r.readStr();
  stash.expansionStatus = r.readByte();

  const sackCount = r.readU32();
  const sacks: StashSack[] = [];
  for (let i = 0; i < sackCount; i++) {
    // Each sack is a nested block (id 0), same as the personal stash's tabs in
    // player.gdc — which is why block 18 can never be blind-skipped.
    const sackBlock = r.beginBlock();
    if (sackBlock.id !== 0) throw new Error(`stash sack ${i}: unexpected nested block id ${sackBlock.id}`);
    const width = r.readU32();
    const height = r.readU32();
    const itemCount = r.readU32();
    const items: PositionedItem[] = [];
    for (let j = 0; j < itemCount; j++) items.push(readStashItem(r));
    // Five trailing words per sack, zero on this machine's stash — the same
    // tail `player.gdc`'s personal-stash tabs carry. Read explicitly so a change
    // in their size surfaces as an "undecoded trailing byte(s)" warning rather
    // than passing silently.
    for (let j = 0; j < 5; j++) r.readU32();
    finishNested(r, sackBlock, warn, `stash sack ${i}`);
    sacks.push({ width, height, items });
  }
  stash.sacks = sacks;
}

export interface ParseGstOptions {
  path?: string;
}

export function parseTransferStash(buf: Buffer, opts: ParseGstOptions = {}): TransferStash {
  const warnings: string[] = [];
  const warn = (msg: string) => warnings.push(msg);

  const r = new GdReader(buf);

  const magic = r.readU32();
  if (magic !== GST_MAGIC) {
    throw new Error(`not a Grim Dawn transfer stash: magic ${magic} != ${GST_MAGIC}`);
  }

  const stash: TransferStash = {
    version: 0,
    mod: '',
    expansionStatus: 0,
    sacks: [],
    blocks: [],
    warnings,
  };
  if (opts.path !== undefined) stash.path = opts.path;

  while (!r.eof) {
    if (r.remaining < 8) {
      warn(`${r.remaining} trailing byte(s) after last block`);
      break;
    }
    const block = r.beginBlock();
    if (block.length > r.remaining) {
      warn(`block ${block.id}: declared length ${block.length} exceeds remaining ${r.remaining}; stopping`);
      break;
    }
    const decode =
      block.id === STASH_BLOCK_ID ? (rr: GdReader) => readStashBlock(rr, stash, warn) : undefined;
    stash.blocks.push(parseBlock(r, block, decode, warn));
  }

  return stash;
}

// ---------------------------------------------------------------------------
// formulas.gst — learned blueprints
// ---------------------------------------------------------------------------

/**
 * `formulas.gst` is a plaintext key/value stream — no cipher, no checksums.
 * Values are typed by key, so the reader has to know the schema; an unknown key
 * is fatal rather than skippable, because without a length prefix on the value
 * there is no way to step over it.
 */
const BEGIN_BLOCK = 0xb01dface;
const END_BLOCK = 0xdeadc0de;

class PlainReader {
  private pos = 0;

  constructor(private readonly buf: Buffer) {}

  get eof(): boolean {
    return this.pos >= this.buf.length;
  }

  get offset(): number {
    return this.pos;
  }

  private need(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new Error(`truncated file: wanted ${n} byte(s) at offset ${this.pos}, file is ${this.buf.length} bytes`);
    }
  }

  readU32(): number {
    this.need(4);
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v >>> 0;
  }

  readByte(): number {
    this.need(1);
    return this.buf[this.pos++]!;
  }

  /** ASCII string: u32 length then that many bytes. */
  readStr(): string {
    const len = this.readU32();
    this.need(len);
    const s = this.buf.toString('latin1', this.pos, this.pos + len);
    this.pos += len;
    return s;
  }
}

export interface FormulaEntry {
  /** DBR record path of the blueprint item, e.g. `records/items/crafting/blueprints/...`. */
  record: string;
  /** Whether the blueprint has been viewed in-game (the "new" marker). */
  read: boolean;
}

export interface FormulasFile {
  /** Absolute path the file was read from, when known. */
  path?: string;
  version: number;
  expansionStatus: number;
  entries: FormulaEntry[];
  warnings: string[];
}

/**
 * Parse the full learned-blueprint file, including its header fields.
 * `parseFormulas` is the plain "just the record paths" wrapper over this.
 */
export function parseFormulasFile(buf: Buffer, opts: ParseGstOptions = {}): FormulasFile {
  const warnings: string[] = [];
  const r = new PlainReader(buf);

  const opener = r.readStr();
  if (opener !== 'begin_block') {
    throw new Error(`not a Grim Dawn formulas file: expected "begin_block", got ${JSON.stringify(opener)}`);
  }
  const beginMarker = r.readU32();
  if (beginMarker !== BEGIN_BLOCK) {
    throw new Error(
      `formulas: bad begin marker 0x${beginMarker.toString(16)} (expected 0x${BEGIN_BLOCK.toString(16)})`,
    );
  }

  const result: FormulasFile = { version: 0, expansionStatus: 0, entries: [], warnings };
  if (opts.path !== undefined) result.path = opts.path;

  let declaredEntries: number | undefined;
  let closed = false;

  while (!r.eof) {
    const key = r.readStr();
    if (key === 'end_block') {
      const endMarker = r.readU32();
      if (endMarker !== END_BLOCK) {
        warnings.push(
          `formulas: bad end marker 0x${endMarker.toString(16)} (expected 0x${END_BLOCK.toString(16)})`,
        );
      }
      closed = true;
      break;
    }

    switch (key) {
      case 'formulasVersion':
        result.version = r.readU32();
        break;
      case 'numEntries':
        declaredEntries = r.readU32();
        break;
      case 'expansionStatus':
        result.expansionStatus = r.readByte();
        break;
      case 'itemName':
        // `formulaRead` follows each `itemName`, so the entry starts here and
        // is completed by the next key.
        result.entries.push({ record: r.readStr(), read: false });
        break;
      case 'formulaRead': {
        const read = r.readU32() !== 0;
        const last = result.entries.at(-1);
        if (!last) throw new Error(`formulas: "formulaRead" at offset ${r.offset} with no preceding "itemName"`);
        last.read = read;
        break;
      }
      default:
        // Values are not length-prefixed as a unit, so an unrecognised key
        // leaves us with no way to resynchronize. Fail loudly instead of
        // returning a half-read list that looks complete.
        throw new Error(`formulas: unknown key ${JSON.stringify(key)} at offset ${r.offset}`);
    }
  }

  if (!closed) warnings.push('formulas: file ended without an "end_block" sentinel');
  if (declaredEntries !== undefined && declaredEntries !== result.entries.length) {
    warnings.push(`formulas: numEntries says ${declaredEntries} but ${result.entries.length} were read`);
  }

  return result;
}

/** The learned blueprints' DBR record paths, in file order. */
export function parseFormulas(buf: Buffer, opts: ParseGstOptions = {}): string[] {
  return parseFormulasFile(buf, opts).entries.map((e) => e.record);
}
