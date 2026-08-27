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

import { ADVISOR_SYSTEM_PROMPT, buildUserTurn } from './prompt.js';
import {
  parseAdvice,
  type ActivityListener,
  type AdvisorProvider,
  type AdvisorRequest,
  type AdvisorResult,
} from './provider.js';
import { defaultSpawn, notFoundMessage, runCommand, stderrTail, type RunResult, type SpawnFn } from './subprocess.js';

export type { SpawnFn } from './subprocess.js';

export const CLAUDE_CLI_ID = 'claude-cli';

/**
 * Opus at **medium** effort. Chosen by an A/B on the live test character
 * (2026-08-10): against high, medium produced the same core moves, filled every
 * socket, capped every resistance *sooner* — high spent its extra ~15k thinking
 * tokens finding a maximum-damage line that left Chaos Resistance 11 under cap
 * for two levels — and did it 22% faster ($2.22/540s vs $2.59/696s, one call
 * each). The thoroughness risk that once argued for high (missed socket fills)
 * is now `unfilled-socket` in `checkPlan`, so the effort knob no longer decides
 * it. High remains a settings choice for whoever wants the deeper search.
 */
export const DEFAULT_MODEL = 'opus';
export const DEFAULT_EFFORT = 'medium';

/**
 * Twenty minutes. Measured, not guessed: a full dossier (~36k tokens in, ~40k
 * out) at `opus` / `high` took **496s** on this machine, so the 180s the stage
 * plan assumed — and the 300s that replaced it — both killed a healthy run. The
 * first live run *from the window* then took 723s across two calls, which is
 * within a factor of two of the old 900s ceiling; a repaired run on a bigger
 * stash would have been killed while it was working. This is a runaway ceiling,
 * not an expectation, and it should sit well clear of a healthy worst case.
 */
export const DEFAULT_TIMEOUT_MS = 1_200_000;

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
  const spawn = opts.spawn ?? defaultSpawn;
  const runOpts = {
    label: 'claude CLI',
    notFoundMessage: notFoundMessage('claude CLI', binary, 'install Claude Code'),
  };
  const run = (args: readonly string[], input: string, timeout: number, signal?: AbortSignal, onStdout?: (chunk: string) => void): Promise<RunResult> =>
    runCommand(spawn, binary, args, input, timeout, signal, { ...runOpts, ...(onStdout ? { onStdout } : {}) });

  return {
    id: CLAUDE_CLI_ID,

    async available(): Promise<boolean> {
      try {
        const probe = await run(['--version'], '', 15_000);
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

      // What the reasoning cost, for `usage` — an effort A/B reads it from the
      // stored envelope to see *where* a cheaper run saved its tokens. Two
      // sources, authoritative first: the final `message_delta`'s usage carries
      // `output_tokens_details.thinking_tokens` (observed 106 where the running
      // estimate said 130), and the `thinking_tokens` estimate events — which a
      // live medium-effort run turned out not to emit at all — are the fallback,
      // sampled off the last `thinking` delta they rode in on.
      let reportedThinking: number | undefined;
      let estimatedThinking: number | undefined;
      const track: ActivityListener = (activity) => {
        if (activity.kind === 'thinking' && activity.outputTokens !== undefined) {
          estimatedThinking = activity.outputTokens;
        }
        onActivity?.(activity);
      };

      const readActivity = activityReader(track, (n) => {
        reportedThinking = n;
      });
      const proc = await run(
        args,
        buildUserTurn(req.contextDoc, req.question, req.planOnly),
        timeoutMs,
        signal,
        readActivity,
      );
      const thinkingTokens = reportedThinking ?? estimatedThinking;

      if (proc.timedOut) {
        throw new Error(
          `claude CLI timed out after ${Math.round(timeoutMs / 1000)}s — raise the timeout, or lower --effort`,
        );
      }
      if (proc.code !== 0) {
        throw new Error(`claude CLI exited ${proc.code ?? 'by signal'}${stderrTail(proc.stderr)}`);
      }

      const envelope = envelopeFrom(proc.stdout);
      if (!envelope) {
        throw new Error(
          `claude CLI did not return JSON — stdout began: ${JSON.stringify(proc.stdout.slice(0, 200))}`,
        );
      }
      if (envelope.is_error || typeof envelope.result !== 'string') {
        const detail = typeof envelope.result === 'string' ? envelope.result : (envelope.subtype ?? 'no result field');
        throw new Error(`claude CLI reported an error — ${detail}${stderrTail(proc.stderr)}`);
      }

      const input = inputTokens(envelope.usage);
      const usage = {
        ...(input !== undefined ? { inputTokens: input } : {}),
        ...(envelope.usage?.output_tokens !== undefined ? { outputTokens: envelope.usage.output_tokens } : {}),
        ...(thinkingTokens !== undefined ? { thinkingTokens } : {}),
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
function activityReader(onActivity: ActivityListener, onThinkingTokens?: (n: number) => void): (chunk: string) => void {
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
      // Emitted as activity in its own right: since CLI 2.1.x the reasoning
      // *text* arrives redacted (every `thinking_delta` carries an empty
      // string), so during the thinking phase — three quarters of a run — this
      // estimate is the only signal that the call is alive. Without the emit,
      // nothing at all reached the window until the answer began.
      if (event.type === 'system' && event.subtype === 'thinking_tokens') {
        if (typeof event.estimated_tokens === 'number') outputTokens = event.estimated_tokens;
        onActivity({ kind: 'thinking', text: '', ...(outputTokens !== undefined ? { outputTokens } : {}) });
        continue;
      }
      if (event.type !== 'stream_event') continue;
      const delta = event.event?.delta;
      const usage = event.event?.usage;
      if (typeof usage?.output_tokens === 'number') outputTokens = usage.output_tokens;
      if (typeof delta?.estimated_tokens === 'number') outputTokens = delta.estimated_tokens;
      // The final `message_delta` states what the reasoning actually cost —
      // the one figure in the stream that is a count rather than an estimate.
      const thinking = usage?.output_tokens_details?.thinking_tokens;
      if (typeof thinking === 'number') onThinkingTokens?.(thinking);
      const text = delta?.thinking ?? delta?.text;
      if (typeof text !== 'string') continue;
      // An empty *thinking* delta still moves the token count — that is the
      // redacted-reasoning heartbeat. An empty answer delta says nothing.
      if (text === '' && delta?.thinking === undefined) continue;
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
    delta?: { thinking?: string; text?: string; estimated_tokens?: number | null };
    usage?: { output_tokens?: number; output_tokens_details?: { thinking_tokens?: number } };
  };
}

