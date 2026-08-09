/**
 * The default advisor backend: the user's own `claude` CLI, which carries their
 * subscription OAuth in the keychain. No API key, no network code here — one
 * subprocess, the document on stdin, a JSON envelope on stdout.
 *
 * The invocation is pinned deliberately:
 *
 * - `--model` and `--effort` are always passed. Without them the subprocess
 *   inherits whatever the user's interactive session or settings happen to say,
 *   which makes two runs of `advise` on the same save silently incomparable.
 * - The document goes over **stdin**: at ~36k tokens it is far past ARG_MAX.
 * - `--tools ""` makes this a pure one-shot completion; `--no-session-persistence`
 *   keeps it out of the user's session history.
 * - `cwd` is the temp directory, so the subprocess does not pick up this repo's
 *   CLAUDE.md or any other project context.
 * - **Never `--bare`** — it disables exactly the OAuth/keychain auth this depends on.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { tmpdir } from 'node:os';

import { ADVISOR_SYSTEM_PROMPT } from './prompt.js';
import {
  parseAdvice,
  type ActivityListener,
  type AdvisorProvider,
  type AdvisorRequest,
  type AdvisorResult,
} from './provider.js';

export const CLAUDE_CLI_ID = 'claude-cli';

/** Opus at high effort: the pair this tool's advice is calibrated against. */
export const DEFAULT_MODEL = 'opus';
export const DEFAULT_EFFORT = 'high';

/**
 * Fifteen minutes. Measured, not guessed: a full dossier (~36k tokens in, ~40k
 * out) at `opus` / `high` took **496s** on this machine, so the 180s the stage
 * plan assumed — and the 300s that replaced it — both killed a healthy run.
 * This is a runaway ceiling, not an expectation.
 */
export const DEFAULT_TIMEOUT_MS = 900_000;

/** Injectable so the tests can drive every branch without a real subprocess. */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface ClaudeCliOptions {
  /** Binary name or absolute path; resolved on PATH when it is a bare name. */
  binary?: string;
  model?: string;
  effort?: string;
  timeoutMs?: number;
  systemPrompt?: string;
  spawn?: SpawnFn;
}

/** The `--output-format json` envelope, as far as we rely on it. */
interface Envelope {
  result?: string;
  is_error?: boolean;
  subtype?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: {
    input_tokens?: number;
    /**
     * The bulk of a dossier lands in one of these two rather than in
     * `input_tokens` — a 36k-token document reported as "2 in" is the envelope
     * telling the truth about caching, not an error. Summed, or the usage line
     * misrepresents the request by four orders of magnitude.
     */
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
}

function inputTokens(usage: Envelope['usage']): number | undefined {
  const parts = [usage?.input_tokens, usage?.cache_creation_input_tokens, usage?.cache_read_input_tokens].filter(
    (n): n is number => typeof n === 'number',
  );
  return parts.length ? parts.reduce((a, b) => a + b, 0) : undefined;
}

export function createClaudeCliProvider(opts: ClaudeCliOptions = {}): AdvisorProvider {
  const binary = opts.binary ?? 'claude';
  const model = opts.model ?? DEFAULT_MODEL;
  const effort = opts.effort ?? DEFAULT_EFFORT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const systemPrompt = opts.systemPrompt ?? ADVISOR_SYSTEM_PROMPT;
  const spawn = opts.spawn ?? (nodeSpawn as SpawnFn);

  return {
    id: CLAUDE_CLI_ID,

    async available(): Promise<boolean> {
      try {
        const probe = await run(spawn, binary, ['--version'], '', 15_000, undefined);
        return probe.code === 0;
      } catch {
        return false;
      }
    },

    async advise(req: AdvisorRequest, signal?: AbortSignal, onActivity?: ActivityListener): Promise<AdvisorResult> {
      const args = [
        '-p',
        // `stream-json` rather than `json`, for one reason: a run is eight to
        // twelve minutes and the plain envelope arrives all at once at the end,
        // so there is nothing to show in between and no way to tell a working
        // call from a wedged one. The *last* line of a stream is the identical
        // `type: "result"` envelope, so this costs the parser nothing — see
        // `envelopeFrom`. `--verbose` is required by the CLI for this format.
        '--output-format',
        'stream-json',
        '--include-partial-messages',
        '--verbose',
        '--model',
        model,
        '--effort',
        effort,
        '--tools',
        '',
        '--no-session-persistence',
        '--system-prompt',
        systemPrompt,
      ];

      const proc = await run(spawn, binary, args, buildInput(req), timeoutMs, signal, onActivity);

      if (proc.timedOut) {
        throw new Error(
          `claude CLI timed out after ${Math.round(timeoutMs / 1000)}s — raise the timeout, or lower --effort`,
        );
      }
      if (proc.code !== 0) {
        throw new Error(`claude CLI exited ${proc.code ?? 'by signal'}${tail(proc.stderr)}`);
      }

      const envelope = envelopeFrom(proc.stdout);
      if (!envelope) {
        throw new Error(
          `claude CLI did not return JSON — stdout began: ${JSON.stringify(proc.stdout.slice(0, 200))}`,
        );
      }
      if (envelope.is_error || typeof envelope.result !== 'string') {
        const detail = typeof envelope.result === 'string' ? envelope.result : (envelope.subtype ?? 'no result field');
        throw new Error(`claude CLI reported an error — ${detail}${tail(proc.stderr)}`);
      }

      const input = inputTokens(envelope.usage);
      const usage = {
        ...(input !== undefined ? { inputTokens: input } : {}),
        ...(envelope.usage?.output_tokens !== undefined ? { outputTokens: envelope.usage.output_tokens } : {}),
        ...(envelope.total_cost_usd !== undefined ? { costUsd: envelope.total_cost_usd } : {}),
        ...(envelope.duration_ms !== undefined ? { durationMs: envelope.duration_ms } : {}),
      };
      const structured = parseAdvice(envelope.result);

      return {
        text: envelope.result,
        provider: CLAUDE_CLI_ID,
        model,
        effort,
        ...(structured ? { structured } : {}),
        ...(Object.keys(usage).length ? { usage } : {}),
      };
    },
  };
}

/**
 * The result envelope out of whatever the CLI printed.
 *
 * A stream ends with one `{"type":"result",…}` line whose fields are the same
 * ones `--output-format json` prints on its own, so both formats are read here by
 * the same code — which is what makes the switch to streaming a change to the
 * *invocation* and not to the parsing. The plain-object branch is not dead code
 * insurance either: `createMockProvider` and the tests print one object.
 */
function envelopeFrom(stdout: string): Envelope | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;

  // Backwards, because the result is the last thing printed and everything
  // before it is a stream event we have already reacted to.
  const lines = trimmed.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const type = (parsed as { type?: unknown }).type;
    if (type === undefined || type === 'result') return parsed as Envelope;
  }
  // A single pretty-printed object spanning several lines.
  try {
    return JSON.parse(trimmed) as Envelope;
  } catch {
    return undefined;
  }
}

/**
 * Turn the stream's line protocol into activity, one chunk of stdout at a time.
 *
 * Stateful because chunk boundaries fall wherever the pipe puts them, which is
 * routinely mid-line and occasionally mid-multi-byte-character; the partial tail
 * is carried to the next chunk. Anything unrecognised is skipped in silence — the
 * event vocabulary is the CLI's and it is free to grow, and a new event kind must
 * not be able to break a twelve-minute run that is otherwise going fine.
 */
function activityReader(onActivity: ActivityListener): (chunk: string) => void {
  let pending = '';
  let outputTokens: number | undefined;

  return (chunk: string): void => {
    pending += chunk;
    const lines = pending.split('\n');
    // The last element is either '' (the chunk ended on a newline) or a partial
    // line; either way it is what carries over.
    pending = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('{')) continue;
      let event: StreamLine;
      try {
        event = JSON.parse(line) as StreamLine;
      } catch {
        continue;
      }

      // The CLI's own running estimate, which is cheaper and steadier than
      // counting deltas — and it counts thinking tokens the deltas do not carry.
      if (event.type === 'system' && event.subtype === 'thinking_tokens') {
        if (typeof event.estimated_tokens === 'number') outputTokens = event.estimated_tokens;
        continue;
      }
      if (event.type !== 'stream_event') continue;
      const delta = event.event?.delta;
      const usage = event.event?.usage;
      if (typeof usage?.output_tokens === 'number') outputTokens = usage.output_tokens;
      const text = delta?.thinking ?? delta?.text;
      if (typeof text !== 'string' || text === '') continue;
      onActivity({
        kind: delta?.thinking !== undefined ? 'thinking' : 'answer',
        text,
        ...(outputTokens !== undefined ? { outputTokens } : {}),
      });
    }
  };
}

/** As much of the stream vocabulary as this reads. Everything else is skipped. */
interface StreamLine {
  type?: string;
  subtype?: string;
  estimated_tokens?: number;
  event?: {
    delta?: { thinking?: string; text?: string };
    usage?: { output_tokens?: number };
  };
}

/**
 * The document, then the question. Appending rather than folding the question
 * into the system prompt keeps the persona identical across runs — only the
 * user turn changes, which is what makes two runs comparable.
 */
function buildInput(req: AdvisorRequest): string {
  if (!req.question) return req.contextDoc;
  return `${req.contextDoc}\n\n---\n\n**Additional instruction from the user — let it steer the answer, but still produce the full output format:** ${req.question}\n`;
}

function tail(stderr: string, limit = 500): string {
  const text = stderr.trim();
  if (!text) return '';
  return `\n${text.length > limit ? `…${text.slice(-limit)}` : text}`;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Spawn, feed stdin, collect both pipes.
 *
 * The child gets its own process group (`detached`) so a timeout or an abort
 * can take down anything it started rather than orphaning it — `claude` is a
 * Node program that spawns helpers of its own.
 */
function run(
  spawn: SpawnFn,
  binary: string,
  args: readonly string[],
  input: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onActivity?: ActivityListener,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(binary, args, {
        cwd: tmpdir(),
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (err) {
      reject(notFound(err, binary));
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const stop = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      process.removeListener('SIGINT', onAbort);
      process.removeListener('SIGTERM', onAbort);
    };
    const kill = (): void => {
      // Negative pid = the whole group. Falls back to the child alone on the
      // platforms/mocks where the group is not addressable.
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const onAbort = (): void => {
      kill();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    // The timer must not hold the process open once everything else is done.
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    // Its own process group means the child does *not* get the terminal's
    // Ctrl-C, so an interrupted CLI would otherwise leave a model call running.
    process.once('SIGINT', onAbort);
    process.once('SIGTERM', onAbort);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    // Still accumulated in full: the result envelope is the last line, and the
    // error paths quote the beginning of stdout. The reader is a second pass over
    // the same bytes, and the whole stream is a few hundred kB.
    const readActivity = onActivity ? activityReader(onActivity) : undefined;
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      // A listener that throws is the consumer's problem, not the run's — this is
      // a progress report on a call that has already been paid for.
      try {
        readActivity?.(chunk);
      } catch {
        /* ignore */
      }
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      stop();
      reject(notFound(err, binary));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      stop();
      if (signal?.aborted && !timedOut) {
        reject(new Error('advice request was cancelled'));
        return;
      }
      resolve({ code, stdout, stderr, timedOut });
    });

    // EPIPE here means the child died before reading; the close handler has the
    // real story, so swallow it rather than racing two rejections.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

function notFound(err: unknown, binary: string): Error {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    return new Error(
      `claude CLI not found (looked for ${JSON.stringify(binary)} on PATH) — install Claude Code, ` +
        'set the binary in settings, or switch provider',
    );
  }
  return new Error(`could not run the claude CLI — ${(err as Error).message}`);
}
