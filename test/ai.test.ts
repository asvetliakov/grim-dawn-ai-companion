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
  checkPlan,
  createClaudeCliProvider,
  createMockProvider,
  createOpenAiProvider,
  createProvider,
  normalizeName,
  normalizeId,
  parseAdvice,
  providerIds,
  slotFlagForClass,
  OPENAI_NOT_CONFIGURED,
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
      '--output-format',
      'json',
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
        hold: [{ itemId: 'ring02', reason: 'r' }],
        sell: [],
      },
      w,
    );
    expect(warnings).toEqual([]);
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
});
