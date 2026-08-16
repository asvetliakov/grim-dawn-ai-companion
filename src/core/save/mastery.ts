/**
 * Removing a mastery from a character.
 *
 * Grim Dawn refunds every point you spent in a mastery and then keeps the
 * mastery: the last point in the bar cannot be taken back, and a second mastery
 * cannot be swapped. So this edits `player.gdc` — the only thing in this tool
 * that writes a save.
 *
 * Three regions change: the header's class tag, block 2's unspent skill points,
 * and block 8's skill list. Everything between and after them is re-enciphered
 * from the recorded transcript, which is why `gdc.ts` decodes all fifteen
 * blocks rather than the seven the rest of the app reads.
 *
 * Every check here reports rather than repairs. A plan with any refusal on it
 * is not written, and `roundtripMismatch` means we could not even reproduce the
 * file we were about to edit — the strongest of them, and the cheapest.
 */

import type { GameDb } from '../db/types.js';
import { encodeBlock2, encodeBlock8, encodeHeader } from './gdc.js';
import { opaqueBlocks, replay, spliceRegion, type Seg, type Transcript } from './transcript.js';
import type { CharacterSave, CharacterSkill } from './types.js';

/** `records/skills/playerclass04/...` — the two digits are the class number. */
const MASTERY_PATH = /^records\/skills\/playerclass(\d+)\//i;
const MASTERY_BAR = /_classtraining_class(\d+)\.dbr$/i;

export interface MasteryRef {
  /** The `_classtraining_classNN.dbr` record. */
  record: string;
  /** The two-digit class number, as it appears in the class tag. */
  classNumber: string;
  name?: string;
  /** Rank of the mastery bar itself: 1 for a fully respecced mastery. */
  barLevel: number;
  /** Entries in block 8 belonging to this mastery, the bar included. */
  entryCount: number;
  /** Skill points sunk into it, the bar included. */
  pointsInvested: number;
}

export type MasteryRemovalRefusal =
  | { kind: 'block-checksum'; blockId: number }
  | { kind: 'resynced-block'; blockId: number }
  | { kind: 'opaque-block'; blockIds: number[] }
  | { kind: 'roundtrip-mismatch'; offset: number }
  | { kind: 'encoder-prefix-mismatch'; detail: string }
  | { kind: 'unknown-mastery'; record: string }
  | { kind: 'last-mastery' }
  | { kind: 'mastery-not-reset'; entryCount: number; pointsInvested: number }
  | { kind: 'save-changed-on-disk' };

export interface MasteryRemovalPlan {
  character: string;
  mastery: MasteryRef;
  /** Every block-8 entry that goes, the bar included. */
  removed: { record: string; name?: string; level: number }[];
  skillPointsBefore: number;
  skillPointsRefunded: number;
  skillPointsAfter: number;
  classRecordBefore: string;
  classRecordAfter: string;
  classNameBefore: string;
  classNameAfter: string;
  remaining: MasteryRef[];
  /** Hot slots and auto-cast bindings naming a removed skill. Expected empty. */
  danglingReferences: string[];
  refusals: MasteryRemovalRefusal[];
  /** The edited file, when there is nothing standing in the way of writing it. */
  output?: Buffer;
}

export function masteryClassNumber(record: string): string | undefined {
  return MASTERY_BAR.exec(record)?.[1] ?? MASTERY_PATH.exec(record)?.[1];
}

function belongsTo(record: string, classNumber: string): boolean {
  return MASTERY_PATH.exec(record)?.[1] === classNumber;
}

/**
 * The character's masteries, read off block 8 rather than off any stored field
 * — the save has none. Membership is decided by the record path and not by a
 * database lookup, because the database deliberately excludes pet subtrees and
 * would answer `undefined` for skills a character really has invested in.
 */
export function characterMasteries(save: CharacterSave, db?: GameDb): MasteryRef[] {
  const byClass = new Map<string, CharacterSkill[]>();
  for (const entry of save.skillEntries) {
    const cls = MASTERY_PATH.exec(entry.record)?.[1];
    if (!cls) continue;
    const list = byClass.get(cls);
    if (list) list.push(entry);
    else byClass.set(cls, [entry]);
  }

  const out: MasteryRef[] = [];
  for (const [classNumber, entries] of byClass) {
    const bar = entries.find((e) => MASTERY_BAR.test(e.record));
    if (!bar) continue; // invested skills with no bar is not a mastery we know
    const ref: MasteryRef = {
      record: bar.record,
      classNumber,
      barLevel: bar.level,
      entryCount: entries.length,
      pointsInvested: entries.reduce((n, e) => n + Math.max(0, e.level), 0),
    };
    const name = db?.getSkill(bar.record)?.name;
    if (name !== undefined) ref.name = name;
    out.push(ref);
  }
  return out.sort((a, b) => a.classNumber.localeCompare(b.classNumber));
}

/**
 * The class tag for a set of masteries: the two-digit class numbers, ascending,
 * concatenated. `tagSkillClassName0410` is Nightblade + Berserker (Reaver);
 * drop the Nightblade and it becomes `tagSkillClassName10`, Berserker.
 */
export function classTagFor(masteries: readonly { classNumber: string }[]): string {
  const numbers = masteries.map((m) => m.classNumber).sort();
  return numbers.length ? `tagSkillClassName${numbers.join('')}` : '';
}

export interface PlanInput {
  character: string;
  save: CharacterSave;
  transcript: Transcript;
  /** The bytes the save was parsed from, for the round-trip check. */
  source: Buffer;
  db?: GameDb;
  /** A mastery record path, its class number, or its localized name. */
  mastery: string;
}

/**
 * Work out what removing a mastery would do, and whether it may be done at all.
 * The edited bytes come back on `output` only when `refusals` is empty.
 */
export function planMasteryRemoval(input: PlanInput): MasteryRemovalPlan {
  const { character, save, transcript, source, db } = input;
  const refusals: MasteryRemovalRefusal[] = [];

  const masteries = characterMasteries(save, db);
  const wanted = input.mastery.trim().toLowerCase();
  const target = masteries.find(
    (m) =>
      m.record.toLowerCase() === wanted ||
      m.classNumber === wanted.padStart(2, '0') ||
      (m.name ?? '').toLowerCase() === wanted,
  );

  const remaining = target ? masteries.filter((m) => m.classNumber !== target.classNumber) : masteries;
  const classRecordBefore = save.classRecord;
  const classRecordAfter = target ? classTagFor(remaining) : classRecordBefore;
  const localize = (tag: string) => db?.localize(tag) ?? tag;

  const removed = target
    ? save.skillEntries
        .filter((e) => belongsTo(e.record, target.classNumber))
        .map((e) => {
          const name = db?.getSkill(e.record)?.name;
          return name === undefined ? { record: e.record, level: e.level } : { record: e.record, name, level: e.level };
        })
    : [];
  const refunded = removed.reduce((n, e) => n + Math.max(0, e.level), 0);

  // --- what stands in the way -------------------------------------------
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

  if (!target) refusals.push({ kind: 'unknown-mastery', record: input.mastery });
  else if (!remaining.length) refusals.push({ kind: 'last-mastery' });
  else if (target.entryCount > 1 || target.barLevel > 1) {
    refusals.push({
      kind: 'mastery-not-reset',
      entryCount: target.entryCount,
      pointsInvested: target.pointsInvested,
    });
  }

  const dangling = target ? danglingReferences(save, target.classNumber) : [];

  const plan: MasteryRemovalPlan = {
    character,
    mastery: target ?? {
      record: input.mastery,
      classNumber: '??',
      barLevel: 0,
      entryCount: 0,
      pointsInvested: 0,
    },
    removed,
    skillPointsBefore: save.attributes.skillPoints,
    skillPointsRefunded: refunded,
    skillPointsAfter: save.attributes.skillPoints + refunded,
    classRecordBefore,
    classRecordAfter,
    classNameBefore: localize(classRecordBefore),
    classNameAfter: localize(classRecordAfter),
    remaining,
    danglingReferences: dangling,
    refusals,
  };

  if (!refusals.length && target) {
    try {
      plan.output = buildEditedSave(save, transcript, target.classNumber, refunded, classRecordAfter);
    } catch (err) {
      refusals.push({ kind: 'encoder-prefix-mismatch', detail: (err as Error).message });
    }
  }
  return plan;
}

/**
 * Auto-cast bindings that would be left pointing at a skill that has gone.
 *
 * Expected to be empty, and the direction is the reason: a binding lives on the
 * *host* player skill and names a devotion, so removing a mastery takes its
 * bindings with it. Kept as a check rather than a repair — a non-empty result
 * means the model of the save is wrong, which is a refusal, not a fix-up.
 */
function danglingReferences(save: CharacterSave, classNumber: string): string[] {
  const going = new Set(
    save.skillEntries.filter((e) => belongsTo(e.record, classNumber)).map((e) => e.record.toLowerCase()),
  );
  const out: string[] = [];
  for (const entry of save.skillEntries) {
    if (belongsTo(entry.record, classNumber)) continue;
    for (const ref of [entry.autoCastSkill, entry.autoCastController]) {
      if (ref && going.has(ref.toLowerCase())) out.push(`${entry.record} → ${ref}`);
    }
  }
  return out;
}

function firstDifference(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

// ---------------------------------------------------------------------------
// The edit
// ---------------------------------------------------------------------------

/**
 * Apply the three edits to the transcript and re-encipher.
 *
 * Each region is spliced by encoding the *unedited* save and requiring it to
 * match what was read, field for field, before the edited encoding replaces it.
 * That check is what makes this safe: an encoder that has drifted from its
 * decoder throws here instead of writing a plausible-looking wrong file.
 */
function buildEditedSave(
  save: CharacterSave,
  transcript: Transcript,
  classNumber: string,
  refunded: number,
  classRecordAfter: string,
): Buffer {
  const after: CharacterSave = {
    ...save,
    classRecord: classRecordAfter,
    attributes: { ...save.attributes, skillPoints: save.attributes.skillPoints + refunded },
    skillEntries: save.skillEntries.filter((e) => !belongsTo(e.record, classNumber)),
  };

  const segments = [...transcript.segments];

  // The header is not a block: it is the leading run of segments up to the
  // first `checksum`, which is the standalone word it ends on.
  const headerEnd = segments.findIndex((s) => s.kind === 'checksum');
  if (headerEnd < 0) throw new Error('header: no trailing checksum in the transcript');
  const header = segments.slice(0, headerEnd + 1);
  const spliced = spliceRegion(header, encodeHeader(save), encodeHeader(after), 'header');
  segments.splice(0, headerEnd + 1, ...spliced);

  editBlock(segments, 2, (body) => {
    const version = versionOf(body, 2);
    return spliceRegion(body, encodeBlock2(save, version), encodeBlock2(after, version), 'block 2');
  });
  editBlock(segments, 8, (body) => {
    const version = versionOf(body, 8);
    return spliceRegion(body, encodeBlock8(save, version), encodeBlock8(after, version), 'block 8');
  });

  return replay({ ...transcript, segments });
}

/** Every block body starts with its version word. */
function versionOf(body: Seg[], blockId: number): number {
  const first = body[0];
  if (first?.kind !== 'u32') throw new Error(`block ${blockId}: body does not start with a version word`);
  return first.value;
}

function editBlock(segments: Seg[], id: number, edit: (body: Seg[]) => Seg[]): void {
  const at = segments.findIndex((s) => s.kind === 'block' && s.id === id);
  if (at < 0) throw new Error(`block ${id}: not in this save`);
  const block = segments[at]!;
  if (block.kind !== 'block') throw new Error(`block ${id}: not a block`);
  segments[at] = { kind: 'block', id, body: edit(block.body) };
}
