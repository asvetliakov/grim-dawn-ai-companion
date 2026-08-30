/**
 * The main process's run manager.
 *
 * `src/main/advise.ts` imports nothing from Electron, which is what lets the
 * hardest half of Stage 7B be tested here rather than by clicking a window:
 * cancellation, a refused second run, a dead backend, and the fact that a run
 * survives a renderer that goes away mid-call. All of those are *timing*, and
 * none of them can be exercised against a real eight-minute subprocess — so the
 * provider is injected, exactly as `claude-cli` injects its `spawn`.
 *
 * The character, though, is the live save: `planCheckInput` verifies a plan
 * against what the document actually offered, and a stubbed dossier would test a
 * document nothing produces.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMockProvider, loadLastAdvice, type AdvisorProvider, type AdvisorResult } from '../src/core/ai/index.js';
import { adviceScope, loadSnapshot, type CharacterSnapshot } from '../src/core/session.js';
import { resolveSettings } from '../src/core/settings.js';
import type { Settings } from '../src/core/settings-schema.js';
import type { PushEvent } from '../src/shared/ipc.js';
import { ALREADY_RUNNING, AdviseRunner, planCheckInput } from '../src/main/advise.js';
import {
  MISSING_GAME_MESSAGE,
  MISSING_SAVES_MESSAGE,
  gameDb,
  haveGameInstall,
  haveLiveSaves,
  primaryLiveCharacter,
} from './paths.js';

const live = haveGameInstall() && haveLiveSaves();

describe.skipIf(!live)(`the advise run manager (${MISSING_GAME_MESSAGE}; ${MISSING_SAVES_MESSAGE})`, () => {
  const originalData = process.env.GD_DATA_DIR;
  let snapshot: CharacterSnapshot;
  let pushes: PushEvent[];

  // Whichever character the roster discovers — never a name written down here.
  // These assertions hardcoded `_Suchka` while the snapshot came from
  // `primaryLiveCharacter()`, which returns the *highest-level* character: the
  // day the user levelled another one past it, six assertions failed on a fact
  // about the save rather than about the run manager. That is the failure
  // `test/paths.ts` describes at length and the reason the roster is discovered.
  let character: string;

  beforeEach(async () => {
    // Advice is written to `<appData>/advice/`, so every test gets its own.
    process.env.GD_DATA_DIR = mkdtempSync(join(tmpdir(), 'gd-runner-'));
    const db = await gameDb();
    character = primaryLiveCharacter();
    snapshot = loadSnapshot(db, resolveSettings(), { character });
    pushes = [];
  });

  afterEach(() => {
    if (originalData === undefined) delete process.env.GD_DATA_DIR;
    else process.env.GD_DATA_DIR = originalData;
  });

  const settings: Settings = { locale: 'en', provider: 'mock', model: 'opus', effort: 'high' };

  function runner(provider: AdvisorProvider): AdviseRunner {
    return new AdviseRunner({
      characterSnapshot: async () => snapshot,
      gameVersion: async () => 'v1.3.0.6',
      currentSettings: () => settings,
      push: (event) => pushes.push(event),
      createProvider: () => provider,
    });
  }

  /** Wait for whichever push ends a run — `done` or `error`. */
  async function settled(): Promise<PushEvent> {
    for (let i = 0; i < 400; i++) {
      const end = pushes.find((e) => e.type === 'advise-done' || e.type === 'advise-error');
      if (end) return end;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`run never settled; pushes: ${pushes.map((p) => p.type).join(', ')}`);
  }

  it('reports the phases in order and pushes the envelope when it is done', async () => {
    // An answer against the real dossier, so the ids resolve and the plan checks
    // have something true to be true about. Every carried candidate goes into
    // `sell`, because coverage is checked now: a plan silent about gear in the
    // bags earns an `unaddressed-item` warning and a repair call this test does
    // not want.
    const [worn] = [...snapshot.doc.itemsById.keys()];
    const carried = [...snapshot.doc.candidateIds].filter(
      (id) => snapshot.doc.itemsById.get(id)?.source === 'inventory',
    );
    const answer =
      '## Verdicts\n\n```json\n' +
      JSON.stringify({
        summary: 'Keep everything worn; nothing carried earns a slot.',
        verdicts: [{ slot: 'Head', itemId: worn, verdict: 'KEEP', reason: 'nothing beats it' }],
        hold: [],
        sell: carried,
      }) +
      '\n```\n';

    const runs = runner(createMockProvider({ text: answer }));
    const { runId } = await runs.start({ question: 'focus on resistances' });
    const end = await settled();

    expect(end.type).toBe('advise-done');
    expect(pushes.filter((p) => p.type === 'advise-progress').map((p) => (p as { phase: string }).phase)).toEqual([
      'context',
      'asking',
    ]);
    const envelope = (end as { envelope: { character: string; question?: string; calls: number } }).envelope;
    expect(envelope.character).toBe(character);
    expect(envelope.question).toBe('focus on resistances');
    expect(envelope.calls).toBe(1);

    // Persisted, and reachable by the two channels the renderer actually calls:
    // the window opens on the empty state and gets to an answer by picking it out
    // of the history, so `history` → `advice` is the whole path in.
    const persisted = loadLastAdvice(character);
    expect(persisted?.answer).toBe(answer);
    // The computed projection rode along: an all-KEEP plan projects to the
    // loadout it started from, with every resistance row present.
    expect(persisted?.projection?.resistances).toHaveLength(10);
    expect(persisted?.projection?.skillRanks).toEqual([]);
    const stored = runs.history(character);
    expect(stored).toHaveLength(1);
    expect(runs.advice(character, stored[0]!.id)?.answer).toBe(answer);
    // And the run is over: a second one is allowed, and the status is idle again.
    expect(runs.status().phase).toBe('idle');
    expect(runId).toMatch(/[0-9a-f-]{36}/);
  });

  it('reports the revising phase when the plan fails a check', async () => {
    // An id no document ever printed, so `checkPlan` fires and the repair loop
    // spends its one corrective call.
    const bad =
      '```json\n' +
      JSON.stringify({ verdicts: [{ slot: 'Head', itemId: 'nope99', verdict: 'KEEP', reason: '' }], hold: [], sell: [] }) +
      '\n```\n';
    const runs = runner(createMockProvider({ answers: [bad, bad] }));
    await runs.start({});
    await settled();
    expect(pushes.filter((p) => p.type === 'advise-progress').map((p) => (p as { phase: string }).phase)).toEqual([
      'context',
      'asking',
      'repair',
    ]);
  });

  it('refuses a second run rather than paying for two answers about one save', async () => {
    const runs = runner(neverAnswers());
    await runs.start({});
    await expect(runs.start({})).rejects.toThrow(ALREADY_RUNNING);
  });

  it('lets a freshly-mounted renderer re-attach to a run it did not start', async () => {
    const runs = runner(neverAnswers());
    const { runId } = await runs.start({});
    const status = runs.status();
    // Everything the renderer needs to draw the panel without having seen a
    // single push: which run, whose, what it is doing and how old it is.
    expect(status).toMatchObject({ phase: 'asking', runId, character });
    expect(status.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('cancels by id, and says so rather than reporting a crash', async () => {
    const runs = runner(neverAnswers());
    const { runId } = await runs.start({});

    // A stale id — a Cancel click that raced a completion — must not kill the
    // run that is actually live.
    runs.cancel('some-other-run');
    expect(runs.status().phase).toBe('asking');

    runs.cancel(runId);
    const end = await settled();
    expect(end).toMatchObject({ type: 'advise-error', runId, message: 'Cancelled.' });
    expect(runs.status().phase).toBe('error');
    // Nothing was written: there is no answer to persist.
    expect(loadLastAdvice(character)).toBeUndefined();
  });

  it('surfaces a backend that cannot run, in the backend’s own words', async () => {
    const runs = runner({
      id: 'broken',
      available: async () => false,
      advise: async () => {
        throw new Error('claude CLI not found on PATH');
      },
    });
    await expect(runs.start({})).rejects.toThrow('claude CLI not found on PATH');
    // And nothing was started, so the button is live again immediately.
    expect(runs.status().phase).toBe('idle');
    expect(pushes).toEqual([]);
  });

  it('keeps a failure until someone asks, so a reload does not lose it', async () => {
    const runs = runner(createMockProvider({ fail: new Error('the model went away') }));
    await runs.start({});
    await settled();
    // The renderer may have been reloading when the error push went out. The
    // status is the second chance.
    expect(runs.status()).toMatchObject({ phase: 'error', message: 'the model went away' });
  });

  /**
   * The stash toggle. Included, the run sends the snapshot's own document —
   * one composition, no drift. Excluded, the stored items leave the resolved
   * walk and the document is rebuilt without them; the materials store is not
   * a stash and always ships, because it is the component census.
   */
  it('leaves the stashes out of the dossier when asked', () => {
    // Stage 12: the advice document is a rebuild of the snapshot's, carrying
    // the candidate projections the watcher-tick build deliberately skips —
    // same ids, same lines, plus the projections — and it is memoised, because
    // the context viewer and the run both ask for it.
    const full = adviceScope(snapshot, true);
    expect(full.doc).not.toBe(snapshot.doc);
    expect(adviceScope(snapshot, true).doc).toBe(full.doc);
    expect([...full.doc.itemsById.keys()]).toEqual([...snapshot.doc.itemsById.keys()]);
    expect(snapshot.doc.projections.size).toBe(0);
    expect(full.doc.projections.size).toBeGreaterThan(0);
    expect(full.doc.markdown).toContain('- projected in ');

    const review = adviceScope(snapshot, true, { reviewStashForSale: true });
    expect(review.doc).not.toBe(full.doc);
    expect(review.doc.reviewStashForSale).toBe(true);
    expect(review.doc.markdown).toContain('**Stash review is ON.**');
    expect(adviceScope(snapshot, true, { reviewStashForSale: true }).doc).toBe(review.doc);

    const filtered = adviceScope(snapshot, false);
    expect(filtered.doc.projections.size).toBeGreaterThan(0);
    expect(filtered.doc.itemsById.size).toBeLessThan(snapshot.doc.itemsById.size);
    for (const item of filtered.doc.itemsById.values()) {
      expect(item.source).not.toBe('stash');
      expect(item.source).not.toBe('transfer');
    }
    expect(filtered.doc.markdown).not.toContain('[stash]');
    expect(filtered.doc.markdown).not.toContain('[transfer]');
    expect([...filtered.doc.itemsById.values()].some((i) => i.source === 'materials')).toBe(true);
    expect(adviceScope(snapshot, false, { reviewStashForSale: true }).doc.reviewStashForSale).toBe(false);
  });

  it('checks the plan against the document, not against the database', () => {
    const check = planCheckInput(snapshot);
    expect(check.itemsById).toBe(snapshot.doc.itemsById);
    expect(check.socketablesById).toBe(snapshot.doc.socketablesById);
    // Coverage is measured against what §7 offered, not against every id.
    expect(check.candidateIds).toBe(snapshot.doc.candidateIds);
    expect(check.reviewStashForSale).toBe(snapshot.doc.reviewStashForSale);
    // Keyed by normalized name, which is the fallback for an answer that gave no
    // socketable id at all.
    expect(check.socketables.size).toBeGreaterThan(0);
    for (const key of check.socketables.keys()) expect(key).toBe(key.toLowerCase());
  });
});

/**
 * A provider that starts and never finishes, so the run stays in flight for as
 * long as the test needs — the state a ~500 second call is in almost always.
 * It resolves only when aborted, which is how the real one behaves too.
 */
function neverAnswers(): AdvisorProvider {
  return {
    id: 'slow',
    available: async () => true,
    advise: (_req, signal) =>
      new Promise<AdvisorResult>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  };
}
