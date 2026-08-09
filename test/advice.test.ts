/**
 * Stage 7B — the envelope, its file, and the item-by-item reading of a plan.
 *
 * The envelope test builds one from the **live save and the real database**,
 * through the mock provider: a hand-written literal would validate against the
 * schema trivially, and the failure worth catching is a producer that has drifted
 * from the shape its consumers parse. Real ids, a real dossier, no model call.
 *
 * `adviceMarks` needs neither, and is tested against plans written by hand — it
 * is the one piece of Stage 7B that is pure enough to have edge cases rather than
 * behaviour.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  adviseEnvelopeSchema,
  adviseWithRepair,
  buildEnvelope,
  advicePath,
  createMockProvider,
  deleteAdvice,
  listAdvice,
  loadAdvice,
  loadLastAdvice,
  saveAdvice,
  normalizeName,
  wornSlots,
  totalUsage,
  type AdviseEnvelope,
} from '../src/core/ai/index.js';
import { documentSocketables } from '../src/core/context/builder.js';
import { loadSnapshot } from '../src/core/session.js';
import { resolveSettings } from '../src/core/settings.js';
import { loadoutDrift, type WornSlot } from '../src/renderer/src/advice.js';
import { adviceMarks, staleIds } from '../src/shared/advice-marks.js';
import { answerProse } from '../src/shared/answer.js';
import type { AdvisorPlan } from '../src/core/ai/provider.js';
import { MISSING_GAME_MESSAGE, MISSING_SAVES_MESSAGE, gameDb, haveGameInstall, haveSaves } from './paths.js';

// ---------------------------------------------------------------------------
// The envelope, from a real run through a fake model
// ---------------------------------------------------------------------------

describe.skipIf(!haveGameInstall())(`the advice envelope (${MISSING_GAME_MESSAGE})`, () => {
  it.skipIf(!haveSaves())(`validates against its own schema (${MISSING_SAVES_MESSAGE})`, async () => {
    const db = await gameDb();
    const snap = loadSnapshot(db, resolveSettings(), { character: '_Suchka' });

    // An answer written against *this* dossier, so the ids in the plan are ids
    // the document really printed — which is what makes `verdictRows` resolve
    // names rather than fall back to "(not in the dossier)".
    const [worn, candidate] = [...snap.doc.itemsById.keys()];
    const answer =
      'Keep the head slot.\n\n```json\n' +
      JSON.stringify({
        summary: 'A test plan over a real dossier.',
        verdicts: [
          {
            slot: 'Head',
            itemId: worn,
            verdict: 'EQUIP',
            target: candidate,
            gains: ['+12% Fire Resistance'],
            reason: 'more Fire Resistance',
          },
        ],
        hold: [],
        sell: [],
      }) +
      '\n```\n';

    const outcome = await adviseWithRepair(
      createMockProvider({ text: answer }),
      { contextDoc: snap.doc.markdown, question: 'focus on resistances' },
      {
        itemsById: snap.doc.itemsById,
        socketables: new Map(documentSocketables(snap.input).map((i) => [normalizeName(i.name), i])),
        socketablesById: snap.doc.socketablesById,
      },
      { repair: false },
    );

    const envelope = buildEnvelope({
      character: snap.character,
      gameVersion: db.gameVersion,
      question: 'focus on resistances',
      outcome,
      usage: totalUsage(outcome.results),
      durationMs: 1234,
      itemNames: Object.fromEntries([...snap.doc.itemsById].map(([id, i]) => [id, i.display])),
      socketableNames: Object.fromEntries([...snap.doc.socketablesById].map(([id, i]) => [id, i.name])),
    });

    const parsed = adviseEnvelopeSchema.safeParse(envelope);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);

    // And it round-trips through JSON, which is what the file and the IPC
    // boundary both do to it.
    expect(adviseEnvelopeSchema.parse(JSON.parse(JSON.stringify(envelope)))).toEqual(envelope);

    // The derived table is really derived — the CLI used to build it separately.
    expect(envelope.verdictRows).toHaveLength(1);
    expect(envelope.verdictRows[0]!.replaces).toBe(true);
    expect(envelope.verdictRows[0]!.nextId).toBe(candidate);
    expect(envelope.verdictRows[0]!.currentName).toBe(snap.doc.itemsById.get(worn!)!.display);
    expect(envelope.question).toBe('focus on resistances');
    expect(envelope.calls).toBe(1);
  });
});

describe('buildEnvelope', () => {
  const outcome = {
    result: { text: 'prose only', provider: 'mock', model: 'mock' },
    warnings: [],
    firstWarnings: [],
    revised: false,
    revisionRejected: false,
    results: [{ text: 'prose only', provider: 'mock' }],
  };
  const base = {
    character: '_Test',
    gameVersion: 'v1.3.0.6',
    outcome,
    usage: { inputTokens: 1, outputTokens: 2, costUsd: 0 },
    durationMs: 5,
    generatedAt: '2026-08-09T00:00:00.000Z',
    itemNames: {},
    socketableNames: {},
  };

  it('omits `question` when there was none, so an old file stays byte-identical', () => {
    expect('question' in buildEnvelope(base)).toBe(false);
  });

  it('keeps an unparseable answer and gives the UI an empty table rather than nothing', () => {
    const envelope = buildEnvelope(base);
    expect(envelope.plan).toBeNull();
    expect(envelope.verdictRows).toEqual([]);
    expect(envelope.answer).toBe('prose only');
    // `model` is nullable rather than optional: the field always exists so a
    // consumer never has to distinguish "no model" from "field not written".
    expect(envelope.effort).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

describe('advice persistence', () => {
  const original = process.env.GD_DATA_DIR;
  let dir: string;

  const envelope = (over: Partial<AdviseEnvelope> = {}): AdviseEnvelope => ({
    character: '_Suchka',
    generatedAt: '2026-08-09T09:15:00.000Z',
    gameVersion: 'v1.3.0.6',
    provider: 'claude-cli',
    model: 'opus',
    effort: 'high',
    calls: 2,
    usage: { inputTokens: 36_412, outputTokens: 40_180, costUsd: 4.16 },
    durationMs: 845_000,
    warnings: [],
    firstWarnings: [{ kind: 'ambiguous-stat', message: 'said "+22 FCL"' }],
    revised: true,
    revisionRejected: false,
    answer: '# Advice\n',
    plan: { verdicts: [], hold: [], sell: [] },
    verdictRows: [],
    itemNames: { a1b2: 'Ashfallen Visor' },
    socketableNames: {},
    ...over,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gd-advice-'));
    process.env.GD_DATA_DIR = dir;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.GD_DATA_DIR;
    else process.env.GD_DATA_DIR = original;
  });

  it('round-trips a run through the file', () => {
    const env = envelope();
    const id = saveAdvice(env);
    expect(loadAdvice('_Suchka', id)).toEqual(env);
    expect(loadLastAdvice('_Suchka')).toEqual(env);
  });

  it('is one directory per character, so a switch does not show the wrong loadout’s advice', () => {
    saveAdvice(envelope());
    saveAdvice(envelope({ character: '_abcdef', answer: '# Different\n' }));
    expect(loadLastAdvice('_Suchka')!.answer).toBe('# Advice\n');
    expect(loadLastAdvice('_abcdef')!.answer).toBe('# Different\n');
    expect(advicePath('_abcdef', 'x')).toBe(join(dir, 'advice', '_abcdef', 'x.json'));
  });

  /**
   * Runs are kept, not overwritten. Each one is minutes and real money, so taking
   * a second opinion must not be a decision to destroy the first answer.
   */
  it('keeps every run for a character, newest first', () => {
    saveAdvice(envelope({ generatedAt: '2026-08-01T10:00:00.000Z', answer: '# First\n' }));
    saveAdvice(envelope({ generatedAt: '2026-08-02T10:00:00.000Z', answer: '# Second\n', question: 'why?' }));

    const runs = listAdvice('_Suchka');
    expect(runs).toHaveLength(2);
    expect(runs[0]!.generatedAt).toBe('2026-08-02T10:00:00.000Z');
    expect(runs[0]!.question).toBe('why?');
    // The summary carries what tells two runs on one save apart at a glance.
    expect(runs[0]!.costUsd).toBe(4.16);
    expect(runs[1]!.question).toBeUndefined();
    // And the newest is what the window opens on.
    expect(loadLastAdvice('_Suchka')!.answer).toBe('# Second\n');
  });

  it('discards one run and answers with what is left', () => {
    saveAdvice(envelope({ generatedAt: '2026-08-01T10:00:00.000Z', answer: '# First\n' }));
    const second = saveAdvice(envelope({ generatedAt: '2026-08-02T10:00:00.000Z', answer: '# Second\n' }));

    const left = deleteAdvice('_Suchka', second);
    expect(left).toHaveLength(1);
    expect(loadLastAdvice('_Suchka')!.answer).toBe('# First\n');
    expect(deleteAdvice('_Suchka', left[0]!.id)).toEqual([]);
    expect(loadLastAdvice('_Suchka')).toBeUndefined();
  });

  /** The id reaches the store from the renderer and becomes a path segment. */
  it('refuses an id that is not a filename it could have written', () => {
    saveAdvice(envelope());
    expect(loadAdvice('_Suchka', '../../settings')).toBeUndefined();
    expect(loadAdvice('_Suchka', 'a/b')).toBeUndefined();
  });

  /** The pre-history layout was one flat file per character. */
  it('migrates a flat advice/<character>.json into the character’s directory', () => {
    const env = envelope({ generatedAt: '2026-07-01T09:00:00.000Z' });
    mkdirSync(join(dir, 'advice'), { recursive: true });
    writeFileSync(join(dir, 'advice', '_Suchka.json'), JSON.stringify(env));

    expect(loadLastAdvice('_Suchka')).toEqual(env);
    expect(existsSync(join(dir, 'advice', '_Suchka.json'))).toBe(false);
    expect(listAdvice('_Suchka')).toHaveLength(1);
  });

  it('answers undefined for a character that has never been advised', () => {
    expect(loadLastAdvice('_Nobody')).toBeUndefined();
    expect(listAdvice('_Nobody')).toEqual([]);
  });

  it('rejects a drifted file rather than throwing — an old cache must not stop the app', () => {
    const id = saveAdvice(envelope());
    const path = advicePath('_Suchka', id);
    const raw = JSON.parse(readFileSync(path, 'utf8'));

    // A field the schema requires, removed by a build that did not have it.
    delete raw.verdictRows;
    writeFileSync(path, JSON.stringify(raw));
    expect(loadLastAdvice('_Suchka')).toBeUndefined();
    // And it is skipped in the listing rather than failing it.
    expect(listAdvice('_Suchka')).toEqual([]);

    // A warning kind from a future build. Same answer, and still no throw.
    writeFileSync(path, JSON.stringify({ ...envelope(), warnings: [{ kind: 'invented', message: 'x' }] }));
    expect(loadLastAdvice('_Suchka')).toBeUndefined();

    // And not even JSON.
    writeFileSync(path, '{ half a fi');
    expect(loadLastAdvice('_Suchka')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The prose half of an answer
// ---------------------------------------------------------------------------

describe('answerProse', () => {
  it('drops the trailing plan block, which the Plan tab has already rendered', () => {
    const answer = '## Reading the build\n\nA pierce build.\n\n```json\n{ "summary": "x" }\n```\n';
    expect(answerProse(answer)).toBe('## Reading the build\n\nA pierce build.');
  });

  it('drops an unclosed trailing block — a truncated answer ends mid-object', () => {
    expect(answerProse('## Prose\n\n```json\n{ "summary": "cut off')).toBe('## Prose');
  });

  it('keeps JSON quoted mid-argument, which is not the plan', () => {
    // The same rule `parseAdvice` relies on: only a block that is genuinely last.
    const answer = '## Prose\n\n```json\n{ "example": 1 }\n```\n\nAnd then more prose.\n';
    expect(answerProse(answer)).toBe(answer);
  });

  it('keeps a trailing fenced block that is not JSON', () => {
    const answer = '## Prose\n\n```text\nnot a plan\n```\n';
    expect(answerProse(answer)).toBe(answer);
  });

  /**
   * The rule is "strip the block the Plan tab is rendering", decided by looking
   * inside. `parseAdvice` accepts a bare fence too, so going by the tag alone
   * would eat any code block an answer happened to end on — a record path, a stat
   * dump — and those are prose the reader wants.
   */
  it('keeps a trailing *bare* block whose contents are not a plan', () => {
    const answer = '## Prose\n\n```\nrecords/items/amulet.dbr  itemLevel=84\n```\n';
    expect(answerProse(answer)).toBe(answer);
  });

  it('strips a trailing bare block that really is the plan', () => {
    expect(answerProse('## Prose\n\n```\n{ "summary": "x", "verdicts": [] }\n```\n')).toBe('## Prose');
  });

  it('leaves an answer with no fences alone', () => {
    expect(answerProse('## Just prose\n')).toBe('## Just prose\n');
  });
});

// ---------------------------------------------------------------------------
// The loadout a run was written against
// ---------------------------------------------------------------------------

/**
 * The distinction this exists for: **carrying the advice out is what makes the
 * loadout differ from it.** A single "is it stale" bit would call an answer stale
 * as its reward for being followed, and the design that suggests itself next —
 * discard the stored run on a mismatch — would delete a twelve-minute answer at
 * exactly the moment the user did what it said.
 */
describe('loadoutDrift', () => {
  const base = (): AdviseEnvelope => ({
    character: '_Suchka',
    generatedAt: '2026-08-09T09:15:00.000Z',
    gameVersion: 'v1.3.0.6',
    provider: 'claude-cli',
    model: 'opus',
    effort: 'high',
    calls: 1,
    usage: { inputTokens: 1, outputTokens: 2, costUsd: 0 },
    durationMs: 1,
    warnings: [],
    firstWarnings: [],
    revised: false,
    revisionRejected: false,
    answer: '',
    plan: { verdicts: [], hold: [], sell: [] },
    verdictRows: [],
    itemNames: {},
    socketableNames: {},
    worn: {},
  });

  const stored = (worn: Record<string, string>, rows: { slot: string; nextId: string }[]): AdviseEnvelope =>
    ({
      ...base(),
      worn,
      verdictRows: rows.map((r) => ({
        slot: r.slot,
        current: '',
        currentName: '',
        currentId: '',
        next: '',
        nextName: '',
        nextId: r.nextId,
        action: '',
        gains: [],
        costs: [],
        why: '',
        replaces: true,
      })),
    });

  /** The live side, as `currentWorn` builds it from the snapshot. */
  const now = (
    slots: Record<string, { itemId: string; display?: string; componentId?: string; augmentId?: string }>,
  ): Record<string, WornSlot> =>
    Object.fromEntries(
      Object.entries(slots).map(([slot, v]) => [slot, { display: '', ...v } as WornSlot]),
    );

  it('reports a slot now holding what the plan told it to equip as done, not stale', () => {
    const env = stored({ Neck: 'old1' }, [{ slot: 'Neck', nextId: 'new1' }]);
    expect(loadoutDrift(env, now({ Neck: { itemId: 'new1' } }))).toEqual([
      { slot: 'Neck', wasId: 'old1', nowId: 'new1', applied: true, changed: 'item', socketNames: [] },
    ]);
  });

  it('reports a slot holding something the plan never mentioned as not applied', () => {
    const env = stored({ Neck: 'old1' }, [{ slot: 'Neck', nextId: 'new1' }]);
    expect(loadoutDrift(env, now({ Neck: { itemId: 'other' } }))[0]).toMatchObject({
      applied: false,
      changed: 'item',
    });
  });

  it('says nothing about slots that have not moved', () => {
    const env = stored({ Neck: 'old1', Head: 'hat1' }, [{ slot: 'Neck', nextId: 'new1' }]);
    expect(loadoutDrift(env, now({ Neck: { itemId: 'old1' }, Head: { itemId: 'hat1' } }))).toEqual([]);
  });

  it('notices a slot emptied and a slot filled', () => {
    const env = stored({ Neck: 'old1' }, []);
    expect(loadoutDrift(env, now({ Head: { itemId: 'hat1' } })).map((d) => [d.slot, d.wasId, d.nowId])).toEqual([
      ['Neck', 'old1', ''],
      ['Head', '', 'hat1'],
    ]);
  });

  /**
   * The case that made `wornSockets` necessary. An item's document id **includes
   * its attachments** — `itemId` hashes the component's and augment's names and
   * seeds — so installing the component the plan asked for changes the worn item's
   * id, and without the sockets-before there is no way to tell that from the item
   * being replaced. Reported as an item change it reads "Feet now holds Bloodhound
   * Greaves (was Bloodhound Greaves)", which is the *opposite* of what happened.
   */
  it('reads an installed component as the socket move being done, not the item changing', () => {
    const env = {
      ...base(),
      worn: { Feet: 'boot0' },
      wornSockets: {},
      itemNames: { boot0: 'Bloodhound Greaves' },
      plan: {
        verdicts: [
          { slot: 'Feet', itemId: 'boot0', verdict: 'ADD-COMPONENT' as const, targetId: 'mark1', reason: '' },
        ],
        hold: [],
        sell: [],
      },
    };
    // Same item, same name, new id because it now carries the component.
    const drift = loadoutDrift(
      env,
      now({ Feet: { itemId: 'boot1', display: 'Bloodhound Greaves', componentId: 'mark1' } }),
    );
    expect(drift).toEqual([
      { slot: 'Feet', wasId: 'boot0', nowId: 'boot1', applied: true, changed: 'sockets', socketNames: ['mark1'] },
    ]);
  });

  it('reads a *different* component as a socket change that was not asked for', () => {
    const env = {
      ...base(),
      worn: { Feet: 'boot0' },
      wornSockets: {},
      itemNames: { boot0: 'Bloodhound Greaves' },
      plan: {
        verdicts: [
          { slot: 'Feet', itemId: 'boot0', verdict: 'ADD-COMPONENT' as const, targetId: 'mark1', reason: '' },
        ],
        hold: [],
        sell: [],
      },
    };
    expect(
      loadoutDrift(env, now({ Feet: { itemId: 'boot2', display: 'Bloodhound Greaves', componentId: 'other' } }))[0],
    ).toMatchObject({ applied: false, changed: 'sockets', socketNames: ['other'] });
  });

  it('counts a `fits` socketable as the plan being carried out too', () => {
    const env = {
      ...base(),
      worn: { Neck: 'amu0' },
      wornSockets: {},
      itemNames: { amu0: 'Bloodmoon' },
      plan: {
        verdicts: [
          {
            slot: 'Neck',
            itemId: 'amu0',
            verdict: 'KEEP' as const,
            fits: [{ kind: 'component' as const, id: 'skull1' }],
            reason: '',
          },
        ],
        hold: [],
        sell: [],
      },
    };
    expect(
      loadoutDrift(env, now({ Neck: { itemId: 'amu1', display: 'Bloodmoon', componentId: 'skull1' } }))[0],
    ).toMatchObject({ applied: true, changed: 'sockets' });
  });

  it('reports nothing for a run stored before the loadout was recorded', () => {
    const old = base();
    delete (old as { worn?: unknown }).worn;
    expect(loadoutDrift(old, now({ Neck: { itemId: 'anything' } }))).toEqual([]);
  });
});

describe('wornSlots', () => {
  it('keys the equipped items by the slot label the dossier prints', () => {
    expect(
      wornSlots([
        { source: 'equipped', location: 'Head', id: 'aaaa' },
        { source: 'equipped', location: 'Weapon set 1 main', id: 'bbbb' },
        { source: 'stash', location: 'Stash tab 3 (2,4)', id: 'cccc' },
      ]),
    ).toEqual({ Head: 'aaaa', 'Weapon set 1 main': 'bbbb' });
  });
});

// ---------------------------------------------------------------------------
// Reading a plan item by item
// ---------------------------------------------------------------------------

function plan(over: Partial<AdvisorPlan> = {}): AdvisorPlan {
  return { verdicts: [], hold: [], sell: [], ...over };
}

describe('adviceMarks', () => {
  it('says nothing about a KEEP — it is the state you are already in', () => {
    const marks = adviceMarks(plan({ verdicts: [v({ slot: 'Head', itemId: 'worn', verdict: 'KEEP' })] }));
    expect(marks.size).toBe(0);
  });

  it('marks both halves of an EQUIP, and only the candidate as incoming', () => {
    const marks = adviceMarks(
      plan({
        verdicts: [
          v({
            slot: 'Hands',
            itemId: 'worn',
            verdict: 'EQUIP',
            target: 'cand',
            gains: ['+18% Chaos Resistance'],
            reason: 'chaos over cap',
          }),
        ],
      }),
    );
    expect([...marks.keys()].sort()).toEqual(['cand', 'worn']);
    expect(marks.get('worn')![0]!.incoming).toBeUndefined();
    expect(marks.get('cand')![0]!.incoming).toBe(true);
    // Both sides carry the argument: the reader may be pointing at either.
    expect(marks.get('cand')![0]!.gains).toEqual(['+18% Chaos Resistance']);
    expect(marks.get('cand')![0]!.slot).toBe('Hands');
  });

  it('takes an EQUIP target from `target` when the answer gave no `targetId`', () => {
    // Which is what the model usually does: for an EQUIP the two fields mean the
    // same thing, and the schema documents `target` as the candidate's item id.
    const withId = adviceMarks(
      plan({ verdicts: [v({ itemId: 'worn', verdict: 'EQUIP', target: 'cand', targetId: 'cand' })] }),
    );
    const withoutId = adviceMarks(plan({ verdicts: [v({ itemId: 'worn', verdict: 'EQUIP', target: 'cand' })] }));
    expect([...withoutId.keys()].sort()).toEqual([...withId.keys()].sort());
  });

  it('leaves a socketable target unmarked — it has no cell to put a badge on', () => {
    const marks = adviceMarks(
      plan({
        verdicts: [
          v({
            slot: 'Feet',
            itemId: 'boots',
            verdict: 'ADD-COMPONENT',
            target: 'Mark of Mogdrogen',
            targetId: 'sock1',
            targetName: 'Mark of Mogdrogen',
          }),
        ],
      }),
    );
    // The host, and nothing else: components live in the reagent store, which is
    // a list of records rather than a grid of instances.
    expect([...marks.keys()]).toEqual(['boots']);
    // The socketable's identity is still on the mark, because "swap the component
    // → Mark of Mogdrogen" is one sentence and the name is half of it.
    expect(marks.get('boots')![0]!.targetId).toBe('sock1');
    expect(marks.get('boots')![0]!.targetName).toBe('Mark of Mogdrogen');
  });

  it('marks an extraction host as destroyed, separately from the slot it serves', () => {
    const marks = adviceMarks(
      plan({
        verdicts: [
          v({
            slot: 'Weapon set 1 main',
            itemId: 'sword',
            verdict: 'SWAP-COMPONENT',
            targetId: 'sock1',
            targetName: 'Bloodied Crystal',
            componentFrom: 'spare',
          }),
        ],
      }),
    );
    expect(marks.get('spare')![0]!.destroys).toBe(true);
    expect(marks.get('spare')![0]!.reason).toMatch(/Destroyed by extracting Bloodied Crystal/);
    // The slot's own item is *not* destroyed — it is the one receiving the part.
    expect(marks.get('sword')![0]!.destroys).toBeUndefined();
  });

  it('carries a hold’s threshold and what it displaces', () => {
    const marks = adviceMarks(
      plan({
        hold: [
          {
            itemId: 'visor',
            slot: 'Head',
            beats: 'worn',
            gains: ['+8% Fire Resistance'],
            reason: 'strictly better',
            until: 'level 84',
          },
        ],
      }),
    );
    const mark = marks.get('visor')![0]!;
    expect(mark.kind).toBe('hold');
    expect(mark.verdict).toBeUndefined();
    expect(mark.until).toBe('level 84');
    expect(mark.slot).toBe('Head');
    expect(mark.targetId).toBe('worn');
  });

  it('marks a bare sell id', () => {
    const marks = adviceMarks(plan({ sell: ['junk'] }));
    expect(marks.get('junk')![0]!.kind).toBe('sell');
  });

  it('keeps both marks when one item is two things at once', () => {
    const marks = adviceMarks(
      plan({
        verdicts: [
          v({ slot: 'Hands', itemId: 'worn', verdict: 'EQUIP', target: 'spare' }),
          v({ slot: 'Feet', itemId: 'boots', verdict: 'SWAP-COMPONENT', targetId: 's1', componentFrom: 'spare' }),
        ],
      }),
    );
    // A candidate for one slot *and* the host an extraction spends. Collapsing
    // that to one mark would drop whichever half came second.
    const spare = marks.get('spare')!;
    expect(spare).toHaveLength(2);
    expect(spare.some((m) => m.incoming)).toBe(true);
    expect(spare.some((m) => m.destroys)).toBe(true);
  });

  it('names the key moves an item belongs to', () => {
    const marks = adviceMarks(
      plan({
        verdicts: [v({ itemId: 'worn', verdict: 'EQUIP', target: 'cand' })],
        keyMoves: [
          { title: 'Close the Bleeding gap', slots: ['Hands'], itemIds: ['cand'], detail: '' },
          { title: 'Unrelated', slots: [], itemIds: ['other'], detail: '' },
        ],
      }),
    );
    expect(marks.get('cand')![0]!.keyMoves).toEqual(['Close the Bleeding gap']);
    expect(marks.get('worn')![0]!.keyMoves).toEqual([]);
    // A key move alone is not an action — it argues about items its verdicts
    // already name, so `other` gets no mark of its own.
    expect(marks.has('other')).toBe(false);
  });

  it('is empty for no plan at all', () => {
    expect(adviceMarks(null).size).toBe(0);
    expect(adviceMarks(undefined).size).toBe(0);
  });
});

describe('staleIds', () => {
  it('names the ids the live snapshot no longer has', () => {
    const marks = adviceMarks(
      plan({ verdicts: [v({ itemId: 'gone', verdict: 'EQUIP', target: 'here' })], sell: ['alsogone'] }),
    );
    const live = new Set(['here']);
    expect(staleIds(marks, (id) => live.has(id)).sort()).toEqual(['alsogone', 'gone']);
  });
});

/** One verdict, with the schema's defaults filled in. */
function v(over: Partial<AdvisorPlan['verdicts'][number]>): AdvisorPlan['verdicts'][number] {
  return { slot: 'Head', itemId: '', verdict: 'KEEP', reason: '', ...over };
}
