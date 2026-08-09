/**
 * Stage 6 — the advisor seam.
 *
 * Everything here runs without a model and without a subprocess: the `claude`
 * binary is replaced by a fake whose behaviour each test dictates, which is the
 * only way to exercise the failure paths (missing binary, non-zero exit,
 * timeout, garbage on stdout) deterministically. What is *not* faked is the
 * argument list and the stdin payload — those are the contract with the real
 * CLI, and they are asserted byte for byte.
 */

import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  ADVISOR_SYSTEM_PROMPT,
  CANNED_ANSWER,
  adviseWithRepair,
  ambiguousStats,
  checkPlan,
  createClaudeCliProvider,
  createMockProvider,
  createOpenAiProvider,
  createProvider,
  isReplacement,
  verdictRows,
  KEEP_CELL,
  nameWithoutQualifier,
  namesAgree,
  normalizeName,
  normalizeId,
  parseAdvice,
  providerIds,
  slotFlagForClass,
  totalUsage,
  OPENAI_NOT_CONFIGURED,
  type AdvisorRequest,
  type SpawnFn,
} from '../src/core/ai/index.js';
import type { DbItem } from '../src/core/db/types.js';
import type { ResolvedItem } from '../src/core/resolve.js';

// ---------------------------------------------------------------------------
// A fake `claude`
// ---------------------------------------------------------------------------

interface FakeRun {
  binary: string;
  args: readonly string[];
  options: SpawnOptions;
  stdin: string;
}

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  /** Left undefined so the kill path takes the single-process branch. */
  readonly pid: number | undefined = undefined;
  killed = false;

  kill(): boolean {
    this.killed = true;
    this.emit('close', null);
    return true;
  }
}

interface FakeSpawn {
  fn: SpawnFn;
  runs: FakeRun[];
}

/**
 * `respond` is called once the child has been handed its stdin, so a test can
 * assert on what was sent and answer in the same place.
 */
function fakeSpawn(respond: (run: FakeRun, child: FakeChild) => void): FakeSpawn {
  const runs: FakeRun[] = [];
  const fn: SpawnFn = (binary, args, options) => {
    const child = new FakeChild();
    const run: FakeRun = { binary, args, options, stdin: '' };
    runs.push(run);
    child.stdin.on('data', (chunk: Buffer | string) => {
      run.stdin += chunk.toString();
    });
    child.stdin.on('finish', () => {
      setImmediate(() => respond(run, child));
    });
    return child as unknown as ChildProcess;
  };
  return { fn, runs };
}

/** The success shape of `claude -p --output-format json`, as of v2.1.220. */
function envelope(result: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    is_error: false,
    subtype: 'success',
    type: 'result',
    total_cost_usd: 0.42,
    duration_ms: 12_345,
    usage: { input_tokens: 36_000, output_tokens: 4_200 },
    result,
    ...over,
  });
}

function finish(child: FakeChild, stdout: string, code = 0, stderr = ''): void {
  if (stdout) child.stdout.write(stdout);
  if (stderr) child.stderr.write(stderr);
  child.stdout.end();
  child.stderr.end();
  child.emit('close', code);
}

// ---------------------------------------------------------------------------
// Plan extraction
// ---------------------------------------------------------------------------

describe('parseAdvice', () => {
  it('reads the whole answer, not only the per-slot table', () => {
    // Everything Stage 7 needs has to survive the round trip, or the UI ends up
    // re-parsing prose for the parts the schema forgot.
    const plan = parseAdvice(
      '```json\n' +
        JSON.stringify({
          summary: 'A Pierce Damage build under cap on Aether Resistance.',
          verdicts: [
            {
              slot: 'Ring 1',
              itemId: '#ring01',
              itemName: 'Old Band',
              verdict: 'EQUIP',
              target: '#ring02',
              targetId: '#ring02',
              targetName: 'Spare Band',
              gains: ['+12% Fire Resistance'],
              costs: ['-5% Attack Speed'],
              reason: 'r',
            },
          ],
          keyMoves: [{ title: 'Free both ring augments', slots: ['Ring 1'], itemIds: ['#ring01'], detail: 'd' }],
          hold: [],
          sell: [],
          projected: { attackSpeedPercent: 182, notDerivable: ['crit damage'], notes: [] },
        }) +
        '\n```',
    );

    expect(plan!.summary).toContain('Pierce Damage');
    expect(plan!.verdicts[0]).toMatchObject({
      itemId: 'ring01',
      itemName: 'Old Band',
      targetId: 'ring02',
      targetName: 'Spare Band',
      gains: ['+12% Fire Resistance'],
    });
    // Ids are normalized wherever they appear, including inside a key move.
    expect(plan!.keyMoves![0]!.itemIds).toEqual(['ring01']);
    expect(plan!.projected).toMatchObject({ attackSpeedPercent: 182, notDerivable: ['crit damage'] });
  });

  it('reads the plan out of the canned answer', () => {
    const plan = parseAdvice(CANNED_ANSWER);
    expect(plan).toBeDefined();
    expect(plan!.verdicts).toHaveLength(2);
    expect(plan!.verdicts[0]).toMatchObject({ slot: 'Head', itemId: 'aaa111', verdict: 'KEEP' });
    expect(plan!.verdicts[1]).toMatchObject({ verdict: 'RE-AUGMENT', target: 'Coven Wendigo Spirit' });
    expect(plan!.hold[0]).toMatchObject({ itemId: 'ccc333', until: 'level 84' });
    expect(plan!.projectedResistances).toEqual({ Fire: 82, Cold: 81, Vitality: 83 });
  });

  it('takes the LAST json block, so prose may quote JSON while explaining', () => {
    const text = [
      'Here is the sort of thing I mean:',
      '```json',
      '{"verdicts": [{"slot": "decoy", "itemId": "zzz", "verdict": "KEEP", "reason": "example"}]}',
      '```',
      'And here is the real plan.',
      '```json',
      '{"verdicts": [{"slot": "Head", "itemId": "real1", "verdict": "KEEP", "reason": "actual"}]}',
      '```',
    ].join('\n');
    expect(parseAdvice(text)!.verdicts[0]).toMatchObject({ slot: 'Head', itemId: 'real1' });
  });

  it('strips the `#` the document prints ids with', () => {
    const text = '```json\n{"verdicts":[{"slot":"Head","itemId":"#abc123","verdict":"EQUIP","target":"#def456","enablers":["#ghi"],"componentFrom":"#jkl","reason":"x"}],"hold":[{"itemId":"#mno","reason":"y"}],"sell":["#pqr"]}\n```';
    const plan = parseAdvice(text)!;
    expect(plan.verdicts[0]).toMatchObject({
      itemId: 'abc123',
      target: 'def456',
      enablers: ['ghi'],
      componentFrom: 'jkl',
    });
    expect(plan.hold[0]!.itemId).toBe('mno');
    expect(plan.sell).toEqual(['pqr']);
    expect(normalizeId('#x')).toBe('x');
  });

  it('leaves a socketable target alone — only EQUIP targets are ids', () => {
    const text = '```json\n{"verdicts":[{"slot":"Ring 1","itemId":"a","verdict":"BUY-AUGMENT","target":"  Kymon\'s Blessing ","reason":"r"}]}\n```';
    expect(parseAdvice(text)!.verdicts[0]!.target).toBe("Kymon's Blessing");
  });

  it('degrades to undefined rather than throwing', () => {
    expect(parseAdvice('no code blocks at all')).toBeUndefined();
    expect(parseAdvice('```json\n{ not json ,,, }\n```')).toBeUndefined();
    // Schema mismatch: an unknown verdict word.
    expect(parseAdvice('```json\n{"verdicts":[{"slot":"Head","itemId":"a","verdict":"YEET"}]}\n```')).toBeUndefined();
    // Right shape, wrong types.
    expect(parseAdvice('```json\n{"verdicts": "all of them"}\n```')).toBeUndefined();
  });

  it('accepts a plan with only some sections filled in', () => {
    const plan = parseAdvice('```json\n{"verdicts":[{"slot":"Head","itemId":"a","verdict":"KEEP","reason":"r"}]}\n```')!;
    expect(plan.hold).toEqual([]);
    expect(plan.sell).toEqual([]);
    expect(plan.projectedResistances).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The claude-cli provider
// ---------------------------------------------------------------------------

describe('claude-cli provider', () => {
  it('assembles the verified invocation and sends the document over stdin', async () => {
    const spawn = fakeSpawn((_run, child) => finish(child, envelope(CANNED_ANSWER)));
    const provider = createClaudeCliProvider({ spawn: spawn.fn });

    const result = await provider.advise({ contextDoc: '# Dossier\n\nbody' });

    const run = spawn.runs[0]!;
    expect(run.binary).toBe('claude');
    expect(run.args).toEqual([
      '-p',
      // Streaming, so a twelve-minute call can report what it is doing. The final
      // line of a stream is the same envelope `json` prints on its own, which is
      // what makes this a change to the invocation and not to the parsing.
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--model',
      'opus',
      '--effort',
      'high',
      '--tools',
      '',
      '--no-session-persistence',
      '--system-prompt',
      ADVISOR_SYSTEM_PROMPT,
    ]);
    // --bare would disable the subscription OAuth this depends on.
    expect(run.args).not.toContain('--bare');
    expect(run.options.cwd).toBe(tmpdir());
    expect(run.stdin).toBe('# Dossier\n\nbody');

    expect(result.text).toBe(CANNED_ANSWER);
    expect(result.provider).toBe('claude-cli');
    expect(result.model).toBe('opus');
    expect(result.effort).toBe('high');
    expect(result.structured!.verdicts).toHaveLength(2);
    expect(result.usage).toEqual({
      inputTokens: 36_000,
      outputTokens: 4_200,
      costUsd: 0.42,
      durationMs: 12_345,
    });
  });

  /**
   * The streaming path, which is the whole reason for `--output-format stream-json`:
   * a run is eight to twelve minutes behind one subprocess, and without this the
   * only honest progress was a phase label that says "asking the model" for the
   * duration.
   */
  it('forwards thinking and answer deltas as activity, and still reads the result line', async () => {
    const stream = [
      '{"type":"system","subtype":"init","tools":[]}',
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Pierce"}}}',
      '{"type":"system","subtype":"thinking_tokens","estimated_tokens":33}',
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":" build"}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"## Reading"}}}',
      // An event kind this does not know. The vocabulary is the CLI's and it is
      // free to grow; a new one must not be able to break a paid-for run.
      '{"type":"invented_event","event":{"nonsense":true}}',
      envelope(CANNED_ANSWER),
      '',
    ].join('\n');

    const spawn = fakeSpawn((_run, child) => finish(child, stream));
    const provider = createClaudeCliProvider({ spawn: spawn.fn });
    const seen: { kind: string; text: string; outputTokens?: number }[] = [];

    const result = await provider.advise({ contextDoc: 'x' }, undefined, (a) => seen.push(a));

    expect(seen.map((a) => `${a.kind}:${a.text}`)).toEqual([
      'thinking:Pierce',
      'thinking: build',
      'answer:## Reading',
    ]);
    // The CLI's own running estimate, picked up from the `thinking_tokens` line
    // that arrived between the two deltas.
    expect(seen[1]!.outputTokens).toBe(33);
    // And the run still produced its answer: the result line is parsed exactly as
    // the non-streaming envelope was.
    expect(result.text).toBe(CANNED_ANSWER);
    expect(result.usage?.costUsd).toBe(0.42);
  });

  it('reassembles a delta split across two stdout chunks', async () => {
    const spawn = fakeSpawn((_run, child) => {
      const line =
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"halves"}}}';
      // Chunk boundaries fall where the pipe puts them, routinely mid-line.
      child.stdout.write(`${line.slice(0, 40)}`);
      child.stdout.write(`${line.slice(40)}\n${envelope(CANNED_ANSWER)}\n`);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0);
    });
    const provider = createClaudeCliProvider({ spawn: spawn.fn });
    const seen: string[] = [];

    await provider.advise({ contextDoc: 'x' }, undefined, (a) => seen.push(a.text));
    expect(seen).toEqual(['halves']);
  });

  it('survives an activity listener that throws — a progress report may not kill a paid run', async () => {
    const stream = [
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"a"}}}',
      envelope(CANNED_ANSWER),
    ].join('\n');
    const spawn = fakeSpawn((_run, child) => finish(child, stream));
    const provider = createClaudeCliProvider({ spawn: spawn.fn });

    const result = await provider.advise({ contextDoc: 'x' }, undefined, () => {
      throw new Error('renderer went away');
    });
    expect(result.text).toBe(CANNED_ANSWER);
  });

  it('counts cached input tokens — the dossier lands there, not in input_tokens', async () => {
    const spawn = fakeSpawn((_run, child) =>
      finish(
        child,
        envelope('ok', {
          usage: {
            input_tokens: 2,
            cache_creation_input_tokens: 36_000,
            cache_read_input_tokens: 1_200,
            output_tokens: 40_000,
          },
        }),
      ),
    );
    const result = await createClaudeCliProvider({ spawn: spawn.fn }).advise({ contextDoc: 'x' });
    expect(result.usage?.inputTokens).toBe(37_202);
    expect(result.usage?.outputTokens).toBe(40_000);
  });

  it('pins whatever model and effort it is given', async () => {
    const spawn = fakeSpawn((_run, child) => finish(child, envelope('ok')));
    await createClaudeCliProvider({ spawn: spawn.fn, model: 'sonnet', effort: 'xhigh' }).advise({ contextDoc: 'x' });
    const args = spawn.runs[0]!.args;
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    expect(args[args.indexOf('--effort') + 1]).toBe('xhigh');
  });

  it('appends the question after the document', async () => {
    const spawn = fakeSpawn((_run, child) => finish(child, envelope('ok')));
    await createClaudeCliProvider({ spawn: spawn.fn }).advise({
      contextDoc: '# Dossier',
      question: 'focus only on resistances',
    });
    const { stdin } = spawn.runs[0]!;
    expect(stdin.startsWith('# Dossier')).toBe(true);
    expect(stdin).toContain('focus only on resistances');
    expect(stdin.indexOf('focus only')).toBeGreaterThan(stdin.indexOf('# Dossier'));
  });

  it('available() runs --version', async () => {
    const spawn = fakeSpawn((_run, child) => finish(child, '2.1.220 (Claude Code)\n'));
    expect(await createClaudeCliProvider({ spawn: spawn.fn }).available()).toBe(true);
    expect(spawn.runs[0]!.args).toEqual(['--version']);

    const broken = fakeSpawn((_run, child) => finish(child, '', 127));
    expect(await createClaudeCliProvider({ spawn: broken.fn }).available()).toBe(false);
  });

  it('says how to fix a missing binary', async () => {
    const thrower: SpawnFn = () => {
      throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    };
    await expect(createClaudeCliProvider({ spawn: thrower }).advise({ contextDoc: 'x' })).rejects.toThrow(
      /claude CLI not found.*install Claude Code/s,
    );

    // The real spawn reports ENOENT as an async 'error' event, not a throw.
    const emitter = fakeSpawn(() => {});
    const async_: SpawnFn = (binary, args, options) => {
      const child = emitter.fn(binary, args, options);
      setImmediate(() => child.emit('error', Object.assign(new Error('nope'), { code: 'ENOENT' })));
      return child;
    };
    await expect(createClaudeCliProvider({ spawn: async_ }).advise({ contextDoc: 'x' })).rejects.toThrow(
      /claude CLI not found/,
    );
    expect(await createClaudeCliProvider({ spawn: async_ }).available()).toBe(false);
  });

  it('includes the stderr tail on a non-zero exit', async () => {
    const spawn = fakeSpawn((_run, child) => finish(child, '', 2, 'Error: credit balance too low'));
    await expect(createClaudeCliProvider({ spawn: spawn.fn }).advise({ contextDoc: 'x' })).rejects.toThrow(
      /exited 2[\s\S]*credit balance too low/,
    );
  });

  it('reports a timeout as one, and kills the child', async () => {
    let child: FakeChild | undefined;
    const spawn = fakeSpawn((_run, c) => {
      child = c; // never finishes
    });
    await expect(
      createClaudeCliProvider({ spawn: spawn.fn, timeoutMs: 30 }).advise({ contextDoc: 'x' }),
    ).rejects.toThrow(/timed out after 0s|timed out/);
    expect(child?.killed).toBe(true);
  });

  it('quotes the start of stdout when the envelope is not JSON', async () => {
    const spawn = fakeSpawn((_run, c) => finish(c, 'Usage: claude [options] [command] [prompt]\n'));
    await expect(createClaudeCliProvider({ spawn: spawn.fn }).advise({ contextDoc: 'x' })).rejects.toThrow(
      /did not return JSON.*Usage: claude/s,
    );
  });

  it('surfaces an is_error envelope', async () => {
    const spawn = fakeSpawn((_run, c) =>
      finish(c, envelope('Context low, aborting', { is_error: true, subtype: 'error_during_execution' })),
    );
    await expect(createClaudeCliProvider({ spawn: spawn.fn }).advise({ contextDoc: 'x' })).rejects.toThrow(
      /reported an error.*Context low/s,
    );
  });

  it('keeps the text when the answer carries no parseable plan', async () => {
    const spawn = fakeSpawn((_run, c) => finish(c, envelope('Just prose, no json block.')));
    const result = await createClaudeCliProvider({ spawn: spawn.fn }).advise({ contextDoc: 'x' });
    expect(result.text).toBe('Just prose, no json block.');
    expect(result.structured).toBeUndefined();
  });

  it('honours an abort signal', async () => {
    const controller = new AbortController();
    const spawn = fakeSpawn(() => controller.abort());
    await expect(
      createClaudeCliProvider({ spawn: spawn.fn }).advise({ contextDoc: 'x' }, controller.signal),
    ).rejects.toThrow(/cancelled/);
  });
});

// ---------------------------------------------------------------------------
// Mock, stub and registry
// ---------------------------------------------------------------------------

describe('providers', () => {
  it('the mock records what it was asked', async () => {
    const calls: { contextDoc: string; question?: string }[] = [];
    const provider = createMockProvider({ calls });
    const result = await provider.advise({ contextDoc: 'doc', question: 'q' });
    expect(calls).toEqual([{ contextDoc: 'doc', question: 'q' }]);
    expect(result.structured!.verdicts).toHaveLength(2);
  });

  it('openai is registered but says it is not configured', async () => {
    const openai = createOpenAiProvider();
    expect(await openai.available()).toBe(false);
    await expect(openai.advise({ contextDoc: 'x' })).rejects.toThrow(OPENAI_NOT_CONFIGURED);
    expect(providerIds()).toEqual(expect.arrayContaining(['claude-cli', 'openai', 'mock']));
  });

  it('names the valid ids when asked for an unknown one', () => {
    expect(() => createProvider('gpt-9')).toThrow(/unknown advisor provider.*claude-cli/s);
    expect(createProvider('claude-cli').id).toBe('claude-cli');
  });
});

// ---------------------------------------------------------------------------
// Plan checks
// ---------------------------------------------------------------------------

function item(over: Partial<ResolvedItem> & { id: string; display: string }): ResolvedItem {
  return {
    record: 'records/items/x.dbr',
    source: 'equipped',
    location: 'Head',
    stackCount: 1,
    unresolved: [],
    ...over,
  } as ResolvedItem;
}

function socketable(name: string, allowedSlots: string[]): DbItem {
  return { record: `records/items/${name}.dbr`, name, levelReq: 1, rarity: 'Common', slot: 'ItemRelic', iconPath: '', stats: {}, allowedSlots };
}

function world(): {
  itemsById: Map<string, ResolvedItem>;
  socketables: Map<string, DbItem>;
  socketablesById: Map<string, DbItem>;
} {
  const helmet = { record: 'records/items/head.dbr', name: 'Helm', levelReq: 1, rarity: 'Epic', slot: 'ArmorProtective_Head', iconPath: '', stats: {} };
  const band = { record: 'records/items/ring.dbr', name: 'Band', levelReq: 1, rarity: 'Epic', slot: 'ArmorJewelry_Ring', iconPath: '', stats: {} };
  return {
    itemsById: new Map([
      ['head01', item({ id: 'head01', display: 'Iron Helm', base: helmet, location: 'Head' })],
      ['ring01', item({ id: 'ring01', display: 'Old Band', base: band, location: 'Ring 1' })],
      ['ring02', item({ id: 'ring02', display: 'Spare Band', base: band, location: 'stash 1', source: 'stash' })],
    ]),
    socketables: new Map([
      [normalizeName('Mark of Illusions'), socketable('Mark of Illusions', ['head', 'chest', 'shoulders'])],
      [normalizeName('Sanctified Bone'), socketable('Sanctified Bone', ['amulet', 'ring', 'medal'])],
    ]),
    socketablesById: new Map([
      ['mark1', socketable('Mark of Illusions', ['head', 'chest', 'shoulders'])],
      ['bone1', socketable('Sanctified Bone', ['amulet', 'ring', 'medal'])],
    ]),
  };
}

describe('checkPlan', () => {
  it('maps a template class onto its use-on flag', () => {
    expect(slotFlagForClass('ArmorProtective_Head')).toBe('head');
    expect(slotFlagForClass('WeaponMelee_Sword2h')).toBe('sword2h');
    expect(slotFlagForClass('WeaponArmor_Offhand')).toBe('offhand');
    expect(slotFlagForClass('ItemRelic')).toBeUndefined();
  });

  it('passes a clean plan', () => {
    const w = world();
    const warnings = checkPlan(
      {
        verdicts: [
          { slot: 'Head', itemId: 'head01', verdict: 'ADD-COMPONENT', target: 'Mark of Illusions', reason: 'r' },
          { slot: 'Ring 1', itemId: 'ring01', verdict: 'EQUIP', target: 'ring02', enablers: ['head01'], reason: 'r' },
        ],
        hold: [
          { itemId: 'ring02', slot: 'Ring 2', beats: 'ring01', gains: ['+12% Fire Resistance'], reason: 'r' },
        ],
        sell: [],
      },
      w,
    );
    expect(warnings).toEqual([]);
  });

  /**
   * A hold is a recommendation, not a status.
   *
   * §12 lists every candidate that fails a requirement so a threshold can be
   * costed against everything it unlocks, and the first live answers read that
   * as a to-do list — marking HOLD on every over-levelled item in the stash
   * whether or not it beat what the character was wearing. A hold that cannot
   * say which slot it is for, what it displaces and what it wins by is that
   * mistake, and it is decidable.
   */
  it('rejects a hold that is only "you cannot wear this yet"', () => {
    const w = world();
    const warnings = checkPlan({ verdicts: [], hold: [{ itemId: 'ring02', reason: 'nice item' }], sell: [] }, w);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.kind).toBe('unjustified-hold');
    expect(warnings[0]!.message).toContain('which slot it is for');
    expect(warnings[0]!.message).toContain('which item it would replace');
    expect(warnings[0]!.message).toContain('what it gains over that item');
  });

  it('names the missing halves of a partly-justified hold', () => {
    const w = world();
    const warnings = checkPlan(
      { verdicts: [], hold: [{ itemId: 'ring02', slot: 'Ring 2', reason: 'r' }], sell: [] },
      w,
    );
    expect(warnings.map((x) => x.kind)).toEqual(['unjustified-hold']);
    expect(warnings[0]!.message).not.toContain('which slot it is for');
    expect(warnings[0]!.message).toContain('which item it would replace and what it gains');
  });

  it('catches a hold that replaces itself, and one that beats an unknown id', () => {
    const w = world();
    const self = checkPlan(
      {
        verdicts: [],
        hold: [{ itemId: 'ring02', slot: 'Ring 2', beats: 'ring02', gains: ['+5% Fire Resistance'], reason: 'r' }],
        sell: [],
      },
      w,
    );
    expect(self.map((x) => x.kind)).toEqual(['unjustified-hold']);
    expect(self[0]!.message).toContain('replaces itself');

    const ghost = checkPlan(
      {
        verdicts: [],
        hold: [{ itemId: 'ring02', slot: 'Ring 2', beats: 'nope99', gains: ['+5% Fire Resistance'], reason: 'r' }],
        sell: [],
      },
      w,
    );
    expect(ghost.map((x) => x.kind)).toEqual(['unknown-id']);
  });

  it('catches an id that is in no part of the document', () => {
    const w = world();
    const warnings = checkPlan(
      {
        verdicts: [
          { slot: 'Head', itemId: 'ghost1', verdict: 'KEEP', reason: 'r' },
          { slot: 'Ring 1', itemId: 'ring01', verdict: 'EQUIP', target: 'ghost2', enablers: ['ghost3'], reason: 'r' },
        ],
        hold: [{ itemId: 'ghost4', reason: 'r' }],
        sell: ['ghost5'],
      },
      w,
    );
    expect(warnings.filter((x) => x.kind === 'unknown-id')).toHaveLength(5);
    expect(warnings[0]!.message).toContain('#ghost1');
  });

  it('catches a socketable proposed for a slot its restriction rejects', () => {
    const w = world();
    const warnings = checkPlan(
      {
        verdicts: [
          { slot: 'Head', itemId: 'head01', verdict: 'ADD-COMPONENT', target: 'Sanctified Bone', reason: 'r' },
        ],
        hold: [],
        sell: [],
      },
      w,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ kind: 'illegal-socket' });
    expect(warnings[0]!.message).toContain('does not accept head');
  });

  /**
   * `fits` is how a slot says "and put these in it" — the second socketable
   * change a one-verdict-per-slot shape had nowhere to put. Its host is the item
   * the slot *ends up* holding, which for an `EQUIP` is the candidate.
   */
  it('checks a fit against the incoming item, not the one being taken off', () => {
    const w = world();
    // Ring 1 is told to equip the spare band and fit a ring-only component. Legal
    // — and it would still be legal read against the outgoing item, which is also
    // a ring, so the case that proves the rule is the head below.
    expect(
      checkPlan(
        {
          verdicts: [
            {
              slot: 'Ring 1',
              itemId: 'ring01',
              verdict: 'EQUIP',
              target: 'ring02',
              fits: [{ kind: 'component', id: 'bone1', name: 'Sanctified Bone' }],
              reason: 'r',
            },
          ],
          hold: [],
          sell: [],
        },
        w,
      ),
    ).toEqual([]);

    // The same component fitted to a *helmet* the plan is equipping: illegal, and
    // only detectable by reading the incoming item's class.
    const warnings = checkPlan(
      {
        verdicts: [
          {
            slot: 'Ring 1',
            itemId: 'ring01',
            verdict: 'EQUIP',
            target: 'head01',
            fits: [{ kind: 'component', id: 'bone1', name: 'Sanctified Bone' }],
            reason: 'r',
          },
        ],
        hold: [],
        sell: [],
      },
      w,
    );
    expect(warnings.map((x) => x.kind)).toContain('illegal-socket');
    expect(warnings.find((x) => x.kind === 'illegal-socket')!.message).toContain('does not accept head');
  });

  it('catches a fit whose id is not a socketable, and one whose name disagrees', () => {
    const w = world();
    const warnings = checkPlan(
      {
        verdicts: [
          {
            slot: 'Head',
            itemId: 'head01',
            verdict: 'KEEP',
            fits: [
              { kind: 'component', id: 'nope', name: 'Invented Thing' },
              // Right id, wrong name — the one failure an id-only plan hides.
              { kind: 'augment', id: 'mark1', name: 'Sanctified Bone' },
            ],
            reason: 'r',
          },
        ],
        hold: [],
        sell: [],
      },
      w,
    );
    expect(warnings.map((x) => x.kind)).toEqual(['unknown-socketable', 'name-mismatch']);
  });

  it('catches two fits of one kind — an item holds one component and one augment', () => {
    const w = world();
    const warnings = checkPlan(
      {
        verdicts: [
          {
            slot: 'Head',
            itemId: 'head01',
            verdict: 'KEEP',
            fits: [
              { kind: 'component', id: 'mark1', name: 'Mark of Illusions' },
              { kind: 'component', id: 'mark1', name: 'Mark of Illusions' },
            ],
            reason: 'r',
          },
        ],
        hold: [],
        sell: [],
      },
      w,
    );
    expect(warnings.map((x) => x.kind)).toEqual(['illegal-socket']);
    expect(warnings[0]!.message).toContain('two components');
  });

  it('catches a socketable the document never offered', () => {
    const w = world();
    const warnings = checkPlan(
      { verdicts: [{ slot: 'Head', itemId: 'head01', verdict: 'BUY-AUGMENT', target: 'Ugdenbog Whatsit', reason: 'r' }], hold: [], sell: [] },
      w,
    );
    expect(warnings[0]).toMatchObject({ kind: 'unknown-socketable' });
  });

  it('catches an extraction host the plan then reuses', () => {
    const w = world();
    const warnings = checkPlan(
      {
        verdicts: [
          { slot: 'Head', itemId: 'head01', verdict: 'ADD-COMPONENT', target: 'Mark of Illusions', componentFrom: 'ring02', reason: 'r' },
          { slot: 'Ring 1', itemId: 'ring02', verdict: 'KEEP', reason: 'r' },
        ],
        hold: [{ itemId: 'ring02', reason: 'r' }],
        sell: ['ring02'],
      },
      w,
    );
    const destroyed = warnings.filter((x) => x.kind === 'destroyed-host');
    expect(destroyed).toHaveLength(3);
    expect(destroyed.map((d) => d.message).join(' ')).toContain('Spare Band');
  });

  it('flags an EQUIP with nothing to equip', () => {
    const warnings = checkPlan(
      { verdicts: [{ slot: 'Head', itemId: 'head01', verdict: 'EQUIP', reason: 'r' }], hold: [], sell: [] },
      world(),
    );
    expect(warnings[0]).toMatchObject({ kind: 'missing-target' });
  });

  it('normalizes the markdown a name may arrive wrapped in', () => {
    expect(normalizeName('**Mark of  Illusions**')).toBe('mark of illusions');
  });

  it('matches a target the model annotated with its source', () => {
    // "ADD-COMPONENT Dread Skull (loose)" is a *correct* move written with an
    // extra word. Raising unknown-socketable for it would be a false alarm on a
    // right answer, which is worse than not checking at all.
    expect(nameWithoutQualifier('Mark of Illusions (loose)')).toBe('mark of illusions');
    const warnings = checkPlan(
      {
        verdicts: [
          { slot: 'Head', itemId: 'head01', verdict: 'ADD-COMPONENT', target: 'Mark of Illusions (loose)', reason: 'r' },
        ],
        hold: [],
        sell: [],
      },
      world(),
    );
    expect(warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Stat clarity
// ---------------------------------------------------------------------------

describe('ambiguous stat references', () => {
  it('flags a bare damage-type name, whatever the sign', () => {
    // Every one of these is a real line from the first live run, and each meant
    // resistance while reading like damage.
    expect(ambiguousStats('+12 Fire/+12 Lightning')).toEqual(['+12 Fire', '+12 Lightning']);
    expect(ambiguousStats('+48 Pierce, +60 Acid')).toEqual(['+48 Pierce', '+60 Acid']);
    expect(ambiguousStats('but costs 35 Acid')).toEqual(['35 Acid']);
  });

  it('accepts a qualified reference, and anything that is not a damage type', () => {
    expect(ambiguousStats('+12% Fire Resistance; +99% Pierce Damage; −35% Acid Resistance')).toEqual([]);
    expect(ambiguousStats('424–505 Fire Retaliation Damage')).toEqual([]);
    expect(ambiguousStats('30% Vitality Damage → Pierce Damage')).toEqual([]);
    expect(ambiguousStats('+308 Health, 1083 Armour, 8× Ugdenbloom, level 84')).toEqual([]);
  });

  it('catches the mixed clause the summary was unreadable because of', () => {
    // "+99% Pierce" is damage and "+22 FCL" is resistance, four words apart.
    expect(ambiguousStats('+99% Pierce, 1083 armour, +22 FCL')).toEqual(['+99% Pierce']);
  });

  it('reports it against the plan, in reasons and in gains/costs', () => {
    const warnings = checkPlan(
      {
        verdicts: [
          {
            slot: 'Head',
            itemId: 'head01',
            verdict: 'KEEP',
            reason: 'best on hand',
            gains: ['+12 Fire'],
            costs: ['-8% Cold Resistance'],
          },
        ],
        hold: [],
        sell: [],
      },
      world(),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ kind: 'ambiguous-stat' });
    expect(warnings[0]!.message).toContain('+12 Fire');
  });

  it('scans the prose too, when the caller supplies it', () => {
    const clean = { verdicts: [], hold: [], sell: [] };
    expect(checkPlan(clean, world(), { answer: 'Neck gains +48 Pierce.' })).toMatchObject([
      { kind: 'ambiguous-stat' },
    ]);
    expect(checkPlan(clean, world(), { answer: 'Neck gains +48% Pierce Resistance.' })).toEqual([]);
  });
});

describe('isReplacement', () => {
  it('is true for EQUIP and false for every socketable verdict', () => {
    // The CLI's table and Stage 7's grid both key "did this slot's item change?"
    // on this, so they cannot disagree about it.
    expect(isReplacement('EQUIP')).toBe(true);
    expect(isReplacement('KEEP')).toBe(false);
    expect(isReplacement('RE-AUGMENT')).toBe(false);
    expect(isReplacement('ADD-COMPONENT')).toBe(false);
    expect(isReplacement('SWAP-COMPONENT')).toBe(false);
    expect(isReplacement('BUY-AUGMENT')).toBe(false);
    expect(isReplacement('CRAFT')).toBe(false);
  });
});

describe('checkPlan — ids and names', () => {
  const plan = (verdict: Record<string, unknown>) =>
    checkPlan({ verdicts: [verdict], hold: [], sell: [] } as never, world());

  it('resolves a socketable by id, so the name needs no normalizing', () => {
    // The name here carries the sourcing annotation the model adds about half
    // the time; with an id present it never has to be parsed off.
    const warnings = plan({
      slot: 'Ring 1',
      itemId: 'ring01',
      verdict: 'ADD-COMPONENT',
      target: 'Sanctified Bone (loose)',
      targetId: 'bone1',
      reason: 'r',
    });
    expect(warnings).toEqual([]);
  });

  it('reports a targetId the document never printed', () => {
    const warnings = plan({
      slot: 'Ring 1',
      itemId: 'ring01',
      verdict: 'ADD-COMPONENT',
      target: 'Sanctified Bone',
      targetId: 'ghost9',
      reason: 'r',
    });
    expect(warnings.map((w) => w.kind)).toContain('unknown-socketable');
  });

  it('catches an id and a name that point at different socketables', () => {
    // The failure an id-only plan hides: the prose argues for one component and
    // the machine-readable half installs another, and both look consistent.
    const warnings = plan({
      slot: 'Ring 1',
      itemId: 'ring01',
      verdict: 'ADD-COMPONENT',
      target: 'Sanctified Bone',
      targetId: 'mark1',
      reason: 'r',
    });
    const mismatch = warnings.find((w) => w.kind === 'name-mismatch');
    expect(mismatch?.message).toContain('Mark of Illusions');
    // …and the legality check still runs against the item the id names.
    expect(warnings.map((w) => w.kind)).toContain('illegal-socket');
  });

  it('tolerates a name quoted without its affixes', () => {
    // Display names carry their affixes; a model writing the base name is being
    // terse, not wrong, and warning on that would be a false alarm on a correct
    // plan — which is worse than no check at all.
    expect(
      plan({ slot: 'Ring 1', itemId: 'ring02', itemName: 'Band', verdict: 'KEEP', reason: 'r' }),
    ).toEqual([]);
    expect(namesAgree('Stealth Jacket', 'Stealth Jacket of the Blind Assassin')).toBe(true);
    expect(namesAgree('**Dread Skull** (loose)', 'Dread Skull')).toBe(true);
    expect(namesAgree('Iron Helm', 'Spare Band')).toBe(false);
  });

  it('catches an item id and name that disagree', () => {
    const warnings = plan({
      slot: 'Head',
      itemId: 'head01',
      itemName: 'Spare Band',
      verdict: 'KEEP',
      reason: 'r',
    });
    expect(warnings.map((w) => w.kind)).toEqual(['name-mismatch']);
    expect(warnings[0]!.message).toContain('Iron Helm');
  });

  it('accepts a matching pair, and a plan that gives no name at all', () => {
    expect(plan({ slot: 'Head', itemId: 'head01', itemName: 'Iron Helm', verdict: 'KEEP', reason: 'r' })).toEqual([]);
    expect(plan({ slot: 'Head', itemId: 'head01', verdict: 'KEEP', reason: 'r' })).toEqual([]);
  });

  it('scans the summary and the key moves for bare stat references', () => {
    const warnings = checkPlan(
      {
        verdicts: [],
        hold: [],
        sell: [],
        summary: 'A pierce build sitting 12 Aether under cap.',
        keyMoves: [{ title: 'Re-slot the rings', slots: [], itemIds: [], detail: 'buys back 22 Chaos' }],
      } as never,
      world(),
    );
    const where = warnings.filter((w) => w.kind === 'ambiguous-stat').map((w) => w.message);
    expect(where.some((m) => m.startsWith('the summary'))).toBe(true);
    expect(where.some((m) => m.includes('key move "Re-slot the rings"'))).toBe(true);
  });
});

describe('verdictRows', () => {
  const names = new Map([
    ['head01', 'Iron Helm'],
    ['ring01', 'Old Band'],
    ['ring02', 'Spare Band'],
  ]);
  const rows = (verdicts: unknown[]) =>
    verdictRows({ verdicts, hold: [], sell: [] } as never, (id) => names.get(id));

  it('makes a replacement and a keep distinguishable at a glance', () => {
    const [keep, equip] = rows([
      { slot: 'Head', itemId: 'head01', verdict: 'KEEP', reason: 'best on hand' },
      { slot: 'Ring 1', itemId: 'ring01', verdict: 'EQUIP', target: 'ring02', reason: 'more pierce resistance' },
    ]);

    expect(keep).toMatchObject({ current: 'Iron Helm #head01', next: KEEP_CELL, action: 'KEEP', replaces: false });
    expect(equip).toMatchObject({
      current: 'Old Band #ring01',
      next: 'Spare Band #ring02',
      action: '',
      replaces: true,
    });
  });

  it('puts a socketable move in Action and leaves the item where it is', () => {
    // A re-augment is not a new item — showing it under New is what made the
    // live run's table unreadable.
    const [row] = rows([
      { slot: 'Ring 1', itemId: 'ring01', verdict: 'RE-AUGMENT', target: 'Coven Wendigo Spirit', reason: 'r' },
    ]);
    expect(row).toMatchObject({
      next: KEEP_CELL,
      action: 'RE-AUGMENT Coven Wendigo Spirit',
      replaces: false,
    });
  });

  it('shows an id the dossier never defined rather than hiding it', () => {
    const [row] = rows([{ slot: 'Head', itemId: 'nope99', verdict: 'KEEP', reason: 'r' }]);
    expect(row!.current).toBe('(not in the dossier) #nope99');
  });

  it('renders an empty slot as a dash', () => {
    const [row] = rows([{ slot: 'Medal', itemId: '', verdict: 'KEEP', reason: 'nothing owned' }]);
    expect(row!.current).toBe('—');
  });

  it('carries the gains and costs through to the row', () => {
    // The live table showed neither, so "+12% Fire Resistance and +12%
    // Lightning Resistance" lived in the prose and nowhere a UI could reach.
    const [row] = rows([
      {
        slot: 'Ring 1',
        itemId: 'ring01',
        verdict: 'RE-AUGMENT',
        target: 'Coven Wendigo Spirit',
        gains: ['+12% Fire Resistance', '+12% Lightning Resistance'],
        costs: ['-5% Attack Speed'],
        reason: 'r',
      },
    ]);
    expect(row!.gains).toEqual(['+12% Fire Resistance', '+12% Lightning Resistance']);
    expect(row!.costs).toEqual(['-5% Attack Speed']);
  });

  it('splits the id out of the label so a UI does not have to parse it back', () => {
    const [keep, equip] = rows([
      { slot: 'Head', itemId: 'head01', verdict: 'KEEP', reason: 'r' },
      { slot: 'Ring 1', itemId: 'ring01', verdict: 'EQUIP', target: 'ring02', reason: 'r' },
    ]);
    expect(keep).toMatchObject({ currentId: 'head01', currentName: 'Iron Helm', nextId: '', nextName: '' });
    expect(equip).toMatchObject({ currentId: 'ring01', nextId: 'ring02', nextName: 'Spare Band' });
  });

  it('defaults a name the dossier does not know to the one the model gave', () => {
    const [row] = rows([
      { slot: 'Head', itemId: 'nope99', itemName: 'Ghost Hat', verdict: 'KEEP', reason: 'r' },
    ]);
    expect(row!.currentName).toBe('Ghost Hat');
  });
});

// ---------------------------------------------------------------------------
// The repair loop
// ---------------------------------------------------------------------------

/** A well-formed answer wrapping the given plan object. */
function answerWith(plan: unknown): string {
  return `## Per-slot verdicts\n\nSome prose.\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\`\n`;
}

const BAD_PLAN = {
  verdicts: [{ slot: 'Head', itemId: 'nope99', verdict: 'KEEP', reason: 'invented id' }],
  hold: [],
  sell: [],
};
const GOOD_PLAN = {
  verdicts: [{ slot: 'Head', itemId: 'head01', verdict: 'KEEP', reason: 'best on hand' }],
  hold: [],
  sell: [],
};

describe('adviseWithRepair', () => {
  it('does not spend a second call on a clean plan', async () => {
    const calls: AdvisorRequest[] = [];
    const provider = createMockProvider({ answers: [answerWith(GOOD_PLAN)], calls });
    const outcome = await adviseWithRepair(provider, { contextDoc: 'doc' }, world());

    expect(calls).toHaveLength(1);
    expect(outcome.revised).toBe(false);
    expect(outcome.warnings).toEqual([]);
  });

  it('asks once with the warnings attached, and keeps the clean revision', async () => {
    const calls: AdvisorRequest[] = [];
    const provider = createMockProvider({ answers: [answerWith(BAD_PLAN), answerWith(GOOD_PLAN)], calls });
    const seen: number[] = [];
    const outcome = await adviseWithRepair(provider, { contextDoc: 'doc' }, world(), {
      onRepair: (w) => seen.push(w.length),
    });

    expect(calls).toHaveLength(2);
    expect(seen).toEqual([1]);
    // The follow-up must carry both halves: what was wrong, and what to fix.
    expect(calls[1]!.contextDoc).toBe('doc');
    expect(calls[1]!.question).toContain('unknown-id');
    expect(calls[1]!.question).toContain('nope99');
    expect(calls[1]!.question).toContain('Your previous answer');

    expect(outcome.revised).toBe(true);
    expect(outcome.revisionRejected).toBe(false);
    expect(outcome.firstWarnings).toHaveLength(1);
    expect(outcome.warnings).toEqual([]);
    expect(outcome.result.text).toContain('head01');
    expect(outcome.results).toHaveLength(2);
  });

  it('never loops: one revision, then it reports', async () => {
    const calls: AdvisorRequest[] = [];
    const provider = createMockProvider({ answers: [answerWith(BAD_PLAN), answerWith(BAD_PLAN)], calls });
    const outcome = await adviseWithRepair(provider, { contextDoc: 'doc' }, world());

    expect(calls).toHaveLength(2);
    expect(outcome.revised).toBe(true);
    expect(outcome.revisionRejected).toBe(true);
    expect(outcome.warnings).toHaveLength(1);
  });

  it('keeps the original when the revision comes back worse', async () => {
    const worse = {
      verdicts: [
        { slot: 'Head', itemId: 'nope99', verdict: 'KEEP', reason: 'still invented' },
        { slot: 'Neck', itemId: 'nope98', verdict: 'KEEP', reason: 'and another' },
      ],
      hold: [],
      sell: [],
    };
    const provider = createMockProvider({ answers: [answerWith(BAD_PLAN), answerWith(worse)] });
    const outcome = await adviseWithRepair(provider, { contextDoc: 'doc' }, world());

    expect(outcome.revisionRejected).toBe(true);
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.result.text).not.toContain('nope98');
  });

  it('honours --no-repair by never making the second call', async () => {
    const calls: AdvisorRequest[] = [];
    const provider = createMockProvider({ answers: [answerWith(BAD_PLAN)], calls });
    const outcome = await adviseWithRepair(provider, { contextDoc: 'doc' }, world(), { repair: false });

    expect(calls).toHaveLength(1);
    expect(outcome.revised).toBe(false);
    expect(outcome.warnings).toHaveLength(1);
  });

  it('leaves an unparseable answer alone — there is nothing to repair', async () => {
    const calls: AdvisorRequest[] = [];
    const provider = createMockProvider({ answers: ['Just prose, no plan.'], calls });
    const outcome = await adviseWithRepair(provider, { contextDoc: 'doc' }, world());

    expect(calls).toHaveLength(1);
    expect(outcome.warnings).toEqual([]);
    expect(outcome.result.structured).toBeUndefined();
  });

  it('totals usage across every call, including a rejected revision', () => {
    const usage = totalUsage([
      { text: '', provider: 'x', usage: { inputTokens: 10, outputTokens: 5, costUsd: 1 } },
      { text: '', provider: 'x', usage: { inputTokens: 20, outputTokens: 7, costUsd: 0.5 } },
    ]);
    expect(usage).toEqual({ inputTokens: 30, outputTokens: 12, costUsd: 1.5 });
  });
});
