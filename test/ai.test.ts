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
  createCodexCliProvider,
  createMockProvider,
  createProvider,
  isReplacement,
  verdictRows,
  KEEP_CELL,
  nameWithoutQualifier,
  namesAgree,
  normalizeName,
  normalizeId,
  parseAdvice,
  providerDefaults,
  providerIds,
  repairEffort,
  slotFlagForClass,
  totalUsage,
  worthRepairing,
  CODEX_DEFAULT_EFFORT,
  CODEX_DEFAULT_MODEL,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  type AdvisorRequest,
  type SpawnFn,
} from '../src/core/ai/index.js';
import type { DbItem } from '@grimdawn/core/db/types';
import type { ResolvedItem } from '@grimdawn/core/resolve';

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

  /**
   * `null` is JSON's `undefined`, and an optional field is where a model reaches
   * for it. A live gpt-5.6 run wrote `"attackSpeedPercent": null` for two speeds
   * it had honestly listed in `notDerivable`, and lost its entire plan — 22k
   * words of analysis — to two type errors on fields the schema calls optional.
   */
  it('reads an explicit null on an optional field as an omission', () => {
    const plan = parseAdvice(
      '```json\n' +
        JSON.stringify({
          verdicts: [{ slot: 'Head', itemId: 'a', verdict: 'KEEP', reason: 'r', gains: null }],
          projected: {
            attackSpeedPercent: null,
            castSpeedPercent: null,
            movementSpeedPercent: 138,
            notDerivable: ['attack speed, because the skill rank moves'],
          },
          hold: [{ itemId: 'b', slot: 'Feet', beats: null, gains: ['+5% Fire Resistance'], reason: 'r' }],
          sell: ['c', null],
        }) +
        '\n```',
    );
    expect(plan).toBeDefined();
    expect(plan!.projected!.attackSpeedPercent).toBeUndefined();
    expect(plan!.projected!.movementSpeedPercent).toBe(138);
    expect(plan!.verdicts[0]!.gains).toBeUndefined();
    expect(plan!.hold[0]!.beats).toBeUndefined();
    // A null inside an array is dropped rather than carried as a hole.
    expect(plan!.sell).toEqual(['c']);
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
      'medium',
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
    expect(result.effort).toBe('medium');
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
      // The final message_delta reports what the reasoning actually cost — a
      // count, which beats the running estimate above (a live run showed 106
      // actual against 130 estimated, and a medium-effort run emitted no
      // estimate events at all).
      '{"type":"stream_event","event":{"type":"message_delta","usage":{"output_tokens":426,"output_tokens_details":{"thinking_tokens":106}}}}',
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
      // The `thinking_tokens` estimate is activity in its own right — on a
      // redacted stream it is the only heartbeat the thinking phase has.
      'thinking:',
      'thinking: build',
      'answer:## Reading',
    ]);
    // The CLI's own running estimate, picked up from the `thinking_tokens` line
    // that arrived between the two deltas.
    expect(seen[1]!.outputTokens).toBe(33);
    expect(seen[2]!.outputTokens).toBe(33);
    // And the run still produced its answer: the result line is parsed exactly as
    // the non-streaming envelope was.
    expect(result.text).toBe(CANNED_ANSWER);
    expect(result.usage?.costUsd).toBe(0.42);
    // The message_delta's counted figure wins over the running estimate (33) —
    // recorded in usage so an effort A/B can read it from the stored envelope.
    expect(result.usage?.thinkingTokens).toBe(106);
  });

  /**
   * The stream the installed CLI (2.1.220) actually produces: every
   * `thinking_delta` carries an **empty string** — the reasoning text is
   * redacted — and the token estimates are all that moves during the thinking
   * phase. Before the heartbeat emit, this stream produced *no activity at all*
   * until the answer began, which is the empty reasoning box a live run showed.
   */
  it('keeps the token count ticking on a redacted thinking stream', async () => {
    const stream = [
      '{"type":"system","subtype":"thinking_tokens","estimated_tokens":50,"estimated_tokens_delta":50}',
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"","estimated_tokens":50}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"","estimated_tokens":null}}}',
      '{"type":"system","subtype":"thinking_tokens","estimated_tokens":72,"estimated_tokens_delta":22}',
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"signature_delta","signature":"xyz"}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"## Reading"}}}',
      envelope(CANNED_ANSWER),
      '',
    ].join('\n');

    const spawn = fakeSpawn((_run, child) => finish(child, stream));
    const provider = createClaudeCliProvider({ spawn: spawn.fn });
    const seen: { kind: string; text: string; outputTokens?: number }[] = [];

    const result = await provider.advise({ contextDoc: 'x' }, undefined, (a) => seen.push(a));

    // Four thinking heartbeats — the two estimate lines and the two empty
    // deltas — then the answer. The signature delta says nothing and is skipped.
    expect(seen.map((a) => `${a.kind}:${a.text}:${a.outputTokens ?? '-'}`)).toEqual([
      'thinking::50',
      'thinking::50',
      'thinking::50',
      'thinking::72',
      'answer:## Reading:72',
    ]);
    expect(result.text).toBe(CANNED_ANSWER);
    // With no message_delta count in this stream, the estimate is the record.
    expect(result.usage?.thinkingTokens).toBe(72);
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

  /**
   * The escape hatch for the PATH a packaged app does not have: a `.app` is
   * launched by launchd, so `~/.local/bin` — where both CLIs install
   * themselves — is not on it, and the settings path is what a run then spawns.
   */
  it('runs the binary it is given rather than the bare name', async () => {
    const spawn = fakeSpawn((_run, child) => finish(child, envelope('ok')));
    await createClaudeCliProvider({ spawn: spawn.fn, binary: '/opt/bin/claude' }).advise({ contextDoc: 'x' });
    expect(spawn.runs[0]!.binary).toBe('/opt/bin/claude');
  });

  it('names the binary it looked for when it is not there', async () => {
    const spawn: SpawnFn = () => {
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    };
    await expect(
      createClaudeCliProvider({ spawn, binary: '/opt/bin/claude' }).advise({ contextDoc: 'x' }),
    ).rejects.toThrow('/opt/bin/claude');
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

  it('registers all three backends', () => {
    expect(providerIds()).toEqual(expect.arrayContaining(['claude-cli', 'codex-cli', 'mock']));
  });

  it('names the valid ids when asked for an unknown one', () => {
    expect(() => createProvider('gpt-9')).toThrow(/unknown advisor provider.*claude-cli/s);
    expect(createProvider('claude-cli').id).toBe('claude-cli');
  });

  // The old call sites reached for claude's DEFAULT_MODEL regardless of
  // backend, which would have handed `opus` to a codex subprocess.
  it('resolves defaults per backend, and no model for the rest', () => {
    expect(providerDefaults('claude-cli')).toEqual({ model: DEFAULT_MODEL, effort: DEFAULT_EFFORT });
    expect(providerDefaults('codex-cli')).toEqual({ model: CODEX_DEFAULT_MODEL, effort: CODEX_DEFAULT_EFFORT });
    expect(providerDefaults('mock')).toEqual({ effort: DEFAULT_EFFORT });
  });
});

// ---------------------------------------------------------------------------
// The codex-cli provider — a fake `codex` this time
// ---------------------------------------------------------------------------

/** One `codex exec --json` stream: reasoning, the answer, then usage. */
function codexStream(answer: string, over: Record<string, unknown> = {}): string {
  return `${[
    JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: '**Weighing the rings**' } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: answer } }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 11_554, cached_input_tokens: 8_064, output_tokens: 654, reasoning_output_tokens: 516 },
      ...over,
    }),
  ].join('\n')}\n`;
}

/**
 * The provider probes `codex login status` before every real call; this answers
 * that probe and hands the exec run to `respond`.
 */
function fakeCodex(respond: (run: FakeRun, child: FakeChild) => void, loggedIn = true): FakeSpawn {
  return fakeSpawn((run, child) => {
    if (run.args[0] === 'login') {
      finish(child, loggedIn ? 'Logged in using ChatGPT\n' : 'Not logged in\n', loggedIn ? 0 : 1);
      return;
    }
    respond(run, child);
  });
}

describe('codex-cli provider', () => {
  it('answers, with the reasoning streamed and the usage mapped', async () => {
    const spawn = fakeCodex((_run, child) => finish(child, codexStream(CANNED_ANSWER)));
    const provider = createCodexCliProvider({ spawn: spawn.fn });
    const activity: { kind: string; text: string }[] = [];
    const result = await provider.advise({ contextDoc: 'doc' }, undefined, (a) => activity.push(a));

    expect(result.provider).toBe('codex-cli');
    expect(result.text).toBe(CANNED_ANSWER);
    expect(result.structured?.verdicts.length).toBeGreaterThan(0);
    // `cached_input_tokens` is a subset of `input_tokens` — no summing, unlike claude.
    expect(result.usage?.inputTokens).toBe(11_554);
    expect(result.usage?.outputTokens).toBe(654);
    expect(result.usage?.thinkingTokens).toBe(516);
    // A subscription run has no dollar figure — absent, never zero.
    expect(result.usage?.costUsd).toBeUndefined();
    // The reasoning reaches the transcript; the answer is never streamed into it.
    expect(activity).toEqual([{ kind: 'thinking', text: '**Weighing the rings**\n\n' }]);
  });

  it('pins the invocation and sends the document over stdin', async () => {
    const spawn = fakeCodex((_run, child) => finish(child, codexStream('ok')));
    const provider = createCodexCliProvider({ spawn: spawn.fn, model: 'gpt-5.5', effort: 'high' });
    await provider.advise({ contextDoc: 'DOC', question: 'why?' });

    const exec = spawn.runs.find((r) => r.args[0] === 'exec')!;
    expect(exec.args).toContain('--json');
    expect(exec.args).toContain('--ephemeral');
    expect(exec.args).toContain('--ignore-user-config');
    expect(exec.args).toContain('--skip-git-repo-check');
    expect(exec.args).toContain('model_reasoning_summary=detailed');
    expect(exec.args).toContain('web_search=disabled');
    expect(exec.args).toContain('gpt-5.5');
    expect(exec.args).toContain('model_reasoning_effort=high');
    // Fast mode (`service_tier=fast`) defaults to on — it is included in the
    // ChatGPT subscription and roughly halves the wait.
    expect(exec.args).toContain('service_tier=fast');
    // The system prompt is the prompt argument; the dossier and the question
    // arrive on stdin, byte-identical to what the claude backend sends.
    expect(exec.args[exec.args.length - 1]).toBe(ADVISOR_SYSTEM_PROMPT);
    expect(exec.stdin).toContain('DOC');
    expect(exec.stdin).toContain('why?');
  });

  it('fast mode can be declined', async () => {
    const spawn = fakeCodex((_run, child) => finish(child, codexStream('ok')));
    const provider = createCodexCliProvider({ spawn: spawn.fn, fast: false });
    await provider.advise({ contextDoc: 'doc' });
    const exec = spawn.runs.find((r) => r.args[0] === 'exec')!;
    expect(exec.args).not.toContain('service_tier=fast');
  });

  it('defaults to gpt-5.6-terra at medium', async () => {
    const spawn = fakeCodex((_run, child) => finish(child, codexStream('ok')));
    const provider = createCodexCliProvider({ spawn: spawn.fn });
    const result = await provider.advise({ contextDoc: 'doc' });
    expect(result.model).toBe(CODEX_DEFAULT_MODEL);
    expect(result.effort).toBe(CODEX_DEFAULT_EFFORT);
    const exec = spawn.runs.find((r) => r.args[0] === 'exec')!;
    expect(exec.args).toContain(CODEX_DEFAULT_MODEL);
    expect(exec.args).toContain(`model_reasoning_effort=${CODEX_DEFAULT_EFFORT}`);
  });

  it('reports available only when signed in, and says how to fix it', async () => {
    const signedIn = fakeCodex(() => {});
    expect(await createCodexCliProvider({ spawn: signedIn.fn }).available()).toBe(true);

    const signedOut = fakeCodex(() => {}, false);
    const provider = createCodexCliProvider({ spawn: signedOut.fn });
    expect(await provider.available()).toBe(false);
    await expect(provider.advise({ contextDoc: 'x' })).rejects.toThrow(/codex login/);
  });

  it('explains an uninstalled binary', async () => {
    const enoent: SpawnFn = () => {
      const err = new Error('spawn codex ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    };
    const provider = createCodexCliProvider({ spawn: enoent });
    expect(await provider.available()).toBe(false);
    await expect(provider.advise({ contextDoc: 'x' })).rejects.toThrow(/install the Codex CLI/);
  });

  it('surfaces the stream error when the run fails', async () => {
    const stream = `${JSON.stringify({ type: 'turn.failed', error: { message: 'model overloaded' } })}\n`;
    const spawn = fakeCodex((_run, child) => finish(child, stream, 1));
    const provider = createCodexCliProvider({ spawn: spawn.fn });
    await expect(provider.advise({ contextDoc: 'x' })).rejects.toThrow(/model overloaded/);
  });

  it('a config warning item does not sink a run that still answered', async () => {
    const stream = `${[
      JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'deprecated config key' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'fine' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }),
    ].join('\n')}\n`;
    const spawn = fakeCodex((_run, child) => finish(child, stream));
    const result = await createCodexCliProvider({ spawn: spawn.fn }).advise({ contextDoc: 'x' });
    expect(result.text).toBe('fine');
  });

  it('a clean exit with no answer is still an error', async () => {
    const stream = `${JSON.stringify({ type: 'turn.started' })}\n`;
    const spawn = fakeCodex((_run, child) => finish(child, stream));
    const provider = createCodexCliProvider({ spawn: spawn.fn });
    await expect(provider.advise({ contextDoc: 'x' })).rejects.toThrow(/produced no answer/);
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
      ['bag01', item({ id: 'bag01', display: 'Rusty Band', base: band, location: 'bag 0', source: 'inventory' })],
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
          { itemId: 'ring02', slot: 'Ring 2', beats: 'ring01', gains: ['+12% Fire Resistance'], reason: 'r', until: 'level 84' },
        ],
        sell: [],
      },
      w,
    );
    expect(warnings).toEqual([]);
  });

  /**
   * A hold waiting on a drop rather than a level: wearable now, a real upgrade,
   * but its swap opens a gap nothing in the dossier covers yet. `until` names
   * the kind of drop; `needs` has nothing to say. Exactly as justified as a
   * level hold — the condition is a sentence either way.
   */
  it('accepts a hold whose condition is a drop rather than a threshold', () => {
    const warnings = checkPlan(
      {
        verdicts: [],
        hold: [
          {
            itemId: 'ring02',
            slot: 'Ring 2',
            beats: 'ring01',
            gains: ['+12% Fire Resistance'],
            reason: 'drops Aether Resistance 30 under cap and no lever covers it',
            until: 'a Chest or Head carrying ≥30% Aether Resistance',
          },
        ],
        sell: [],
      },
      world(),
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
    expect(warnings[0]!.message).toContain('until when it is held');
  });

  it('names the missing halves of a partly-justified hold', () => {
    const w = world();
    const warnings = checkPlan(
      { verdicts: [], hold: [{ itemId: 'ring02', slot: 'Ring 2', reason: 'r', until: 'level 84' }], sell: [] },
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
        hold: [{ itemId: 'ring02', slot: 'Ring 2', beats: 'ring02', gains: ['+5% Fire Resistance'], reason: 'r', until: 'level 84' }],
        sell: [],
      },
      w,
    );
    expect(self.map((x) => x.kind)).toEqual(['unjustified-hold']);
    expect(self[0]!.message).toContain('replaces itself');

    const ghost = checkPlan(
      {
        verdicts: [],
        hold: [{ itemId: 'ring02', slot: 'Ring 2', beats: 'nope99', gains: ['+5% Fire Resistance'], reason: 'r', until: 'level 84' }],
        sell: [],
      },
      w,
    );
    expect(ghost.map((x) => x.kind)).toEqual(['unknown-id']);
  });

  /**
   * Stored items are being kept on purpose — the player moved them there. A
   * plan may recommend wearing or holding one; disposing of it second-guesses
   * a decision the dossier already shows was made.
   */
  it('rejects SELL on an item that lives in the stash', () => {
    const warnings = checkPlan({ verdicts: [], hold: [], sell: ['ring02'] }, world());
    expect(warnings.map((x) => x.kind)).toEqual(['sell-in-stash']);
    expect(warnings[0]!.message).toContain('Spare Band');
  });

  /**
   * Coverage: silence about carried gear the document offered reads as "never
   * considered", and the reader cannot tell it from an oversight. Scoped to
   * the bags — the same silence about a stored item is correct behaviour — and
   * to the offered set, because an item the model was never shown cannot be
   * demanded a verdict on.
   */
  it('demands a disposition for every carried item the document offered', () => {
    const w = { ...world(), candidateIds: new Set(['ring02', 'bag01']) };
    const ignored = checkPlan({ verdicts: [], hold: [], sell: [] }, w);
    expect(ignored.map((x) => x.kind)).toEqual(['unaddressed-item']);
    expect(ignored[0]!.message).toContain('Rusty Band');

    // Any disposition clears it — here a sell. And without `candidateIds` the
    // check cannot run at all, which is what an older caller gets.
    expect(checkPlan({ verdicts: [], hold: [], sell: ['bag01'] }, w)).toEqual([]);
    expect(checkPlan({ verdicts: [], hold: [], sell: [] }, world())).toEqual([]);
  });

  it('checks nextLevels unlocks like any other id', () => {
    const warnings = checkPlan(
      {
        verdicts: [],
        hold: [],
        sell: [],
        nextLevels: [{ threshold: 'level 84', unlocks: ['nope99'], recommendation: 'r' }],
      },
      world(),
    );
    expect(warnings.map((x) => x.kind)).toEqual(['unknown-id']);
    expect(warnings[0]!.message).toContain('level 84');
  });

  /**
   * §12 costs every blocked candidate; a live gpt-5.6 run mirrored the whole
   * ladder back as sixteen rows, fourteen of them "skip, off-build". A
   * threshold's unlocks are the items the plan is holding for it — everything
   * else is a reader sent hunting for gear the same answer advises against.
   */
  it('rejects a Next levels unlock the plan is not holding', () => {
    const w = world();
    const held = {
      itemId: 'ring02',
      slot: 'Ring 2',
      beats: 'ring01',
      gains: ['+5% Fire Resistance'],
      reason: 'r',
      until: 'level 84',
    };

    const noisy = checkPlan(
      {
        verdicts: [],
        hold: [held],
        sell: [],
        nextLevels: [
          { threshold: 'level 84', unlocks: ['ring02', 'bag01', 'head01'], recommendation: 'equip the first, skip the rest' },
        ],
      },
      w,
    );
    expect(noisy.map((x) => x.kind)).toEqual(['uncommitted-next-level']);
    expect(noisy[0]!.message).toContain('Rusty Band');
    expect(noisy[0]!.message).toContain('Iron Helm');
    expect(noisy[0]!.message).not.toContain('Spare Band');

    // Held unlocks only, and an empty entry (a farming target, or the one line
    // saying nothing is worth committing to), both pass.
    expect(
      checkPlan(
        {
          verdicts: [],
          hold: [held],
          sell: [],
          nextLevels: [
            { threshold: 'level 84', unlocks: ['ring02'], recommendation: 'commit' },
            { threshold: 'farm Manticore Eye ×9', unlocks: [], recommendation: 'long-term' },
          ],
        },
        w,
      ),
    ).toEqual([]);
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
// The tally vs the computed projection
// ---------------------------------------------------------------------------

describe('checkPlan — overstated caps', () => {
  /** A projection with just the resistance rows the case needs. */
  const projection = (rows: { label: string; after: number; capAfter: number }[]) => ({
    resistances: rows.map((r) => ({ before: 0, afterPermanent: r.after, ...r })),
    speeds: [],
    damage: [],
    totalDamagePercent: { before: 0, after: 0 },
    skillRanks: [],
    skipped: [],
    notes: [],
  });
  const w = (rows: { label: string; after: number; capAfter: number }[]) => ({
    ...world(),
    project: () => projection(rows),
  });
  const acidPlan = { verdicts: [], hold: [], sell: [], projectedResistances: { Acid: 100 } };

  it('fires when the tally claims capped and the computed figure is under cap — and buys a repair', () => {
    // The live case, twice over: `-28% Acid Resistance` in a verdict's costs,
    // dropped from the tally, Acid reported capped while it ends 8 short.
    const warnings = checkPlan(acidPlan, w([{ label: 'Acid', after: 72, capAfter: 80 }]));
    expect(warnings.map((x) => x.kind)).toEqual(['overstated-cap']);
    expect(warnings[0]!.message).toContain('Acid Resistance at 100');
    expect(warnings[0]!.message).toContain('72 effective, 8 short');
    // Unlike a wording warning, this one is structure: it justifies the call.
    expect(worthRepairing(warnings)).toBe(true);
  });

  it('stays silent for an honest under-cap figure — that is a decision, not a slip', () => {
    const honest = { verdicts: [], hold: [], sell: [], projectedResistances: { Acid: 72 } };
    expect(checkPlan(honest, w([{ label: 'Acid', after: 72, capAfter: 80 }]))).toEqual([]);
  });

  it('stays silent at cap, within the ±2 rounding band, and case-insensitively matches labels', () => {
    const capped = { verdicts: [], hold: [], sell: [], projectedResistances: { fire: 110 } };
    expect(checkPlan(capped, w([{ label: 'Fire', after: 110, capAfter: 80 }]))).toEqual([]);
    const rounding = { verdicts: [], hold: [], sell: [], projectedResistances: { Cold: 80 } };
    expect(checkPlan(rounding, w([{ label: 'Cold', after: 79, capAfter: 80 }]))).toEqual([]);
  });

  it('checks nothing without a tally, a projector, or a projection', () => {
    expect(checkPlan({ verdicts: [], hold: [], sell: [] }, w([{ label: 'Acid', after: 72, capAfter: 80 }]))).toEqual([]);
    expect(checkPlan(acidPlan, world())).toEqual([]);
    expect(checkPlan(acidPlan, { ...world(), project: () => undefined })).toEqual([]);
  });

  it('stands down when the projection itself skipped a verdict — a partial figure indicts nothing', () => {
    // A CRAFT or an unknown id leaves the computed figure missing gains the
    // model legitimately counted; the unknown id warns on its own already.
    const partial = {
      ...world(),
      project: () => ({
        ...projection([{ label: 'Acid', after: 72, capAfter: 80 }]),
        skipped: [{ slot: 'Chest', verdict: 'CRAFT', reason: 'the item is transformed; the result is not projectable' }],
      }),
    };
    expect(checkPlan(acidPlan, partial)).toEqual([]);
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

  it('accepts a label–value list, where each type is followed by its own number', () => {
    // Both live runs wrote their projected-resistance summary in this shape,
    // and each spent a full repair call on the seam between two entries
    // ("92, Cold") being read as a stat. The second run's revision then failed
    // to fix it — six minutes and two dollars for a false alarm.
    expect(ambiguousStats('Permanent-only (buff dropped): Fire 92, Cold 90, Lightning 80 — all at or over cap')).toEqual([]);
    expect(ambiguousStats('Fire Resistance 94 → 142, Lightning 94 → 142, Cold 94 → 130')).toEqual([]);
    expect(ambiguousStats('Vitality 317. Bleeding 318. All effective.')).toEqual([]);
    // The DoT twins are two words; the value sits after the tail word.
    expect(ambiguousStats('projected: Vitality 80, Vitality Decay 78')).toEqual([]);
  });

  it('keeps flagging a signed value after the type — that is a new stat, not a list entry', () => {
    expect(ambiguousStats('+48 Pierce, +60 Acid Resistance')).toEqual(['+48 Pierce']);
    // And the list tolerance is same-line only: a stat that ends its line is
    // still bare whatever the next line opens with.
    expect(ambiguousStats('gains +35 Acid\n90 more to cap')).toEqual(['+35 Acid']);
  });

  it('accepts the shapes §4 now renders, so an answer echoing them is not flagged', () => {
    // The RR wording, the rank tables' row labels and the weighted focus line
    // are all fully qualified on purpose — a model quoting any of them back
    // must not buy a repair call.
    expect(ambiguousStats('-32% Enemy Fire, Cold and Lightning Resistances (for 5s)')).toEqual([]);
    expect(ambiguousStats('-22 to All Enemy Resistances')).toEqual([]);
    expect(ambiguousStats('| Fire Damage (flat, midpoint) | 120 | 130 |')).toEqual([]);
    expect(ambiguousStats('| -N% Enemy Cold Resistance | 23 | 25 |')).toEqual([]);
    expect(ambiguousStats('Build focus: Pierce Damage (+1556% modifiers) + Bleeding Damage (+1203% modifiers)')).toEqual([]);
    // The payload index is not a damage-type name; an answer stating its delta
    // ("costs 4.1% of the payload") must not buy a repair call either.
    expect(ambiguousStats('payload index 41,200 → 39,500 (−4.1%)')).toEqual([]);
    expect(ambiguousStats('Weapon payload index: 7739 — this plan costs 3% of it')).toEqual([]);
  });

  it('accepts absorption and composition shares — the first post-8B run’s surviving warning was these', () => {
    // Both are verbatim from the opus post-8B live answer, and both were false
    // alarms on correct prose: absorption is a stat kind of its own (statfmt
    // prints `525 Physical Damage Absorption`), and a share of the weapon
    // attack is a §4 composition claim a resistance cannot make.
    expect(ambiguousStats('a 525 Physical/Pierce absorption proc')).toEqual([]);
    expect(ambiguousStats('which does feed the 10% Frostburn share of the weapon attack')).toEqual([]);
    // The qualifier still has to be there: the same numbers bare stay flagged.
    expect(ambiguousStats('a 525 Physical proc')).toEqual(['525 Physical']);
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

describe('checkPlan — empty component sockets', () => {
  const keepHead = { slot: 'Head', itemId: 'head01', verdict: 'KEEP' as const, reason: 'r' };

  it('flags a slot that ends the plan with an empty socket a free component would fit', () => {
    const warnings = checkPlan(
      { verdicts: [keepHead], hold: [], sell: [] },
      { ...world(), freeComponentIds: new Set(['mark1']) },
    );
    expect(warnings).toMatchObject([{ kind: 'unfilled-socket' }]);
    expect(warnings[0]!.message).toContain('Iron Helm');
    expect(warnings[0]!.message).toContain('Mark of Illusions');
  });

  it('is satisfied by a component in fits, or by a component verdict', () => {
    const viaFits = checkPlan(
      { verdicts: [{ ...keepHead, fits: [{ kind: 'component', id: 'mark1' }] }], hold: [], sell: [] },
      { ...world(), freeComponentIds: new Set(['mark1']) },
    );
    expect(viaFits).toEqual([]);
    const viaVerdict = checkPlan(
      {
        verdicts: [{ slot: 'Head', itemId: 'head01', verdict: 'ADD-COMPONENT', target: 'Mark of Illusions', reason: 'r' }],
        hold: [],
        sell: [],
      },
      { ...world(), freeComponentIds: new Set(['mark1']) },
    );
    expect(viaVerdict).toEqual([]);
  });

  it('stays silent when no free component fits the slot, or when the socket is filled', () => {
    // bone1 is ring-only, so an empty head socket is not a missed move.
    expect(
      checkPlan({ verdicts: [keepHead], hold: [], sell: [] }, { ...world(), freeComponentIds: new Set(['bone1']) }),
    ).toEqual([]);
    // And a filled socket owes nothing.
    const w = world();
    const helmet = { record: 'records/items/head.dbr', name: 'Helm', levelReq: 1, rarity: 'Epic', slot: 'ArmorProtective_Head', iconPath: '', stats: {} };
    w.itemsById.set(
      'head01',
      item({ id: 'head01', display: 'Iron Helm', base: helmet, component: socketable('Sanctified Bone', []) }),
    );
    expect(
      checkPlan({ verdicts: [keepHead], hold: [], sell: [] }, { ...w, freeComponentIds: new Set(['mark1']) }),
    ).toEqual([]);
  });

  it('checks the item the slot ends up holding — an EQUIP is judged by its candidate', () => {
    const warnings = checkPlan(
      {
        verdicts: [{ slot: 'Ring 1', itemId: 'ring01', verdict: 'EQUIP', target: 'ring02', reason: 'r' }],
        hold: [],
        sell: [],
      },
      { ...world(), freeComponentIds: new Set(['bone1']) },
    );
    expect(warnings).toMatchObject([{ kind: 'unfilled-socket' }]);
    expect(warnings[0]!.message).toContain('Spare Band');
  });

  it('runs only when the caller says which components are free', () => {
    expect(checkPlan({ verdicts: [keepHead], hold: [], sell: [] }, world())).toEqual([]);
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
    // And it must ask for an erratum, not another answer — the whole saving.
    expect(calls[1]!.planOnly).toBe(true);
    expect(calls[1]!.question).toContain('Do not rewrite the analysis');

    expect(outcome.revised).toBe(true);
    expect(outcome.revisionRejected).toBe(false);
    expect(outcome.firstWarnings).toHaveLength(1);
    expect(outcome.warnings).toEqual([]);
    expect(outcome.result.text).toContain('head01');
    expect(outcome.results).toHaveLength(2);
  });

  it('splices the corrected plan under the analysis the first call paid for', async () => {
    const first = `## Reading the build\n\nA long and expensive pierce analysis.\n\n\`\`\`json\n${JSON.stringify(BAD_PLAN)}\n\`\`\`\n`;
    const erratum = `Fixed the invented id.\n\n\`\`\`json\n${JSON.stringify(GOOD_PLAN)}\n\`\`\`\n`;
    const provider = createMockProvider({ answers: [first, erratum] });
    const outcome = await adviseWithRepair(provider, { contextDoc: 'doc' }, world());

    expect(outcome.warnings).toEqual([]);
    // The analysis survives, the note joins it, the plan is the corrected one.
    expect(outcome.result.text).toContain('A long and expensive pierce analysis.');
    expect(outcome.result.text).toContain('Fixed the invented id.');
    expect(outcome.result.text).toContain('head01');
    expect(outcome.result.text).not.toContain('nope99');
    // Text and plan must agree: the checks join them, so a stale `structured`
    // would be the one inconsistency nothing downstream could catch.
    expect(outcome.result.structured?.verdicts[0]?.itemId).toBe('head01');
  });

  it('takes a revision whole when the model rewrote the answer anyway', async () => {
    // The escape hatch: a backend that will not follow the shorter contract
    // costs what it always did, rather than getting its answer mangled.
    const first = `## Short\n\n\`\`\`json\n${JSON.stringify(BAD_PLAN)}\n\`\`\`\n`;
    const rewrite = `## Reading the build\n\nA whole new and much longer analysis, rewritten in full.\n\n\`\`\`json\n${JSON.stringify(GOOD_PLAN)}\n\`\`\`\n`;
    const provider = createMockProvider({ answers: [first, rewrite] });
    const outcome = await adviseWithRepair(provider, { contextDoc: 'doc' }, world());

    expect(outcome.result.text).toBe(rewrite);
    expect(outcome.result.text).not.toContain('## Short');
    expect(outcome.warnings).toEqual([]);
  });

  it('lets an erratum with no plan block stand on its own', async () => {
    const first = `## Reading the build\n\nThe original analysis, which is quite long indeed.\n\n\`\`\`json\n${JSON.stringify(BAD_PLAN)}\n\`\`\`\n`;
    const provider = createMockProvider({ answers: [first, 'I cannot fix that: the id is in the dossier.'] });
    const outcome = await adviseWithRepair(provider, { contextDoc: 'doc' }, world());

    // Nothing to splice, so nothing is spliced — and with no plan there are no
    // warnings against it, which loses to the original's one and is discarded.
    expect(outcome.revisionRejected).toBe(true);
    expect(outcome.result.text).toBe(first);
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

  it('does not spend a second call on prose-only warnings', async () => {
    // Both live runs spent a full second Opus call — six minutes and two
    // dollars each — on nothing but `ambiguous-stat`, and one revision then
    // failed to fix it. Wording is reported to the user, not re-bought.
    const proseOnly = {
      verdicts: [{ slot: 'Head', itemId: 'head01', verdict: 'KEEP', reason: 'costs 35 Acid' }],
      hold: [],
      sell: [],
    };
    const calls: AdvisorRequest[] = [];
    const provider = createMockProvider({ answers: [answerWith(proseOnly)], calls });
    const outcome = await adviseWithRepair(provider, { contextDoc: 'doc' }, world());

    expect(calls).toHaveLength(1);
    expect(outcome.revised).toBe(false);
    expect(outcome.warnings.length).toBeGreaterThan(0);
    expect(outcome.warnings.every((w) => w.kind === 'ambiguous-stat')).toBe(true);
  });

  it('worthRepairing separates structure from wording', () => {
    expect(worthRepairing([{ kind: 'ambiguous-stat', message: 'm' }])).toBe(false);
    expect(
      worthRepairing([
        { kind: 'ambiguous-stat', message: 'm' },
        { kind: 'unknown-id', message: 'm' },
      ]),
    ).toBe(true);
  });

  it('sends the corrective call to the repair provider when one is given', async () => {
    const firstCalls: AdvisorRequest[] = [];
    const repairCalls: AdvisorRequest[] = [];
    const provider = createMockProvider({ answers: [answerWith(BAD_PLAN)], calls: firstCalls });
    const repairProvider = createMockProvider({ answers: [answerWith(GOOD_PLAN)], calls: repairCalls });
    const outcome = await adviseWithRepair(provider, { contextDoc: 'doc' }, world(), { repairProvider });

    expect(firstCalls).toHaveLength(1);
    expect(repairCalls).toHaveLength(1);
    expect(outcome.revised).toBe(true);
    expect(outcome.warnings).toEqual([]);
  });

  it('repairEffort lowers the deep tiers and leaves the rest alone', () => {
    expect(repairEffort('high')).toBe('medium');
    expect(repairEffort('xhigh')).toBe('medium');
    expect(repairEffort('max')).toBe('medium');
    expect(repairEffort('ultra')).toBe('medium');
    expect(repairEffort('medium')).toBe('medium');
    expect(repairEffort('low')).toBe('low');
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
    // No thinkingTokens key at all when no call reported one: a zero would read
    // as "did no reasoning" where the truth is "the backend did not say".
    expect(usage).toEqual({ inputTokens: 30, outputTokens: 12, costUsd: 1.5 });
  });

  it('sums the thinking estimate when the calls carry one', () => {
    const usage = totalUsage([
      { text: '', provider: 'x', usage: { inputTokens: 10, outputTokens: 5, costUsd: 1, thinkingTokens: 4 } },
      { text: '', provider: 'x', usage: { inputTokens: 20, outputTokens: 7, costUsd: 0.5 } },
    ]);
    expect(usage).toEqual({ inputTokens: 30, outputTokens: 12, costUsd: 1.5, thinkingTokens: 4 });
  });

  it('claims no cost when no call priced itself — a codex run is not free, it is unpriced', () => {
    const usage = totalUsage([
      { text: '', provider: 'codex-cli', usage: { inputTokens: 10, outputTokens: 5, thinkingTokens: 4 } },
      { text: '', provider: 'codex-cli', usage: { inputTokens: 20, outputTokens: 7 } },
    ]);
    expect(usage).toEqual({ inputTokens: 30, outputTokens: 12, thinkingTokens: 4 });
    expect('costUsd' in usage).toBe(false);
  });
});
