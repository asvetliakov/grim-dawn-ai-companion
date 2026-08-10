/**
 * The OpenAI backend: the user's own `codex` CLI, signed in with their ChatGPT
 * subscription (`codex login`). Same shape as the claude-cli provider — one
 * subprocess, the document on stdin, JSONL on stdout — and the same reasons:
 * no API key, no network code, no token to store or refresh.
 *
 * The invocation is pinned deliberately:
 *
 * - `-m` and `-c model_reasoning_effort` are always passed, so two runs on the
 *   same save are comparable — exactly the claude-cli rule.
 * - `--ignore-user-config` is required, not hygiene: the user's
 *   `~/.codex/config.toml` injects feature warnings as `error` items into the
 *   stream and can spin up MCP servers and hooks. Auth still works with it.
 * - `-c model_reasoning_summary=detailed` is what makes reasoning exist in the
 *   stream at all — without it a ten-minute run emits nothing until the answer.
 * - `--ephemeral` is claude's `--no-session-persistence`; `-s read-only` plus an
 *   empty tmpdir cwd (hence `--skip-git-repo-check`) plus `web_search=disabled`
 *   keeps an agentic CLI a pure one-shot completion.
 * - The system prompt travels as the prompt *argument* (codex has no
 *   `--system-prompt` flag); the dossier is piped and arrives as the CLI's own
 *   `<stdin>` block under it, so the persona stays identical across runs.
 *
 * A subscription run has no dollar figure, so `usage.costUsd` is never set —
 * the envelope and the usage lines treat "absent" as "included in the
 * subscription", not as zero.
 */

// Same runaway ceiling as claude-cli, for the same measured reasons.
import { DEFAULT_TIMEOUT_MS } from './claude-cli.js';
import { ADVISOR_SYSTEM_PROMPT, buildUserTurn } from './prompt.js';
import {
  parseAdvice,
  type ActivityListener,
  type AdvisorProvider,
  type AdvisorRequest,
  type AdvisorResult,
} from './provider.js';
import { defaultSpawn, runCommand, stderrTail, type RunResult, type SpawnFn } from './subprocess.js';

export const CODEX_CLI_ID = 'codex-cli';

/**
 * gpt-5.6-sol at **medium** — the frontier model of the current generation,
 * picked by the user when the backend landed (2026-08-10). Medium was then
 * confirmed by an A/B against high on the live character, same method as the
 * opus default: identical equips and socket fills, every resistance capped in
 * both, 9 of 12 non-KEEP moves byte-identical — high spent 15.8k thinking
 * tokens to medium's 6.3k (668s vs 440s, both runs pre-fast-mode) re-shuffling
 * which of the same three resistance powders goes where, and its *first* draft
 * was the less clean one (2 warnings incl. an `unaddressed-item` vs 1).
 * Effort names are the Responses API's own enum (`none`…`max`, plus `ultra` on
 * the 5.6 models — verified live; `minimal` is rejected there, and there is no
 * `fast`). `none` is deliberately not offered in settings: the floor is `low`,
 * because an advisory answer with no reasoning is a plan acted on blind.
 */
export const CODEX_DEFAULT_MODEL = 'gpt-5.6-sol';
export const CODEX_DEFAULT_EFFORT = 'medium';

export interface CodexCliOptions {
  /** Binary name or absolute path; resolved on PATH when it is a bare name. */
  binary?: string;
  model?: string;
  effort?: string;
  /**
   * Fast mode (`service_tier=fast`) — the renamed "priority processing",
   * included in the ChatGPT subscription at a 2–2.5× credit burn. **Defaults
   * to on**: it roughly halves the wait, and the credits are the plan's to
   * spend. Verified live against this CLI/account (2026-08-10).
   */
  fast?: boolean;
  timeoutMs?: number;
  systemPrompt?: string;
  spawn?: SpawnFn;
}

const NOT_INSTALLED =
  'codex CLI not found on PATH — install the Codex CLI (`npm install -g @openai/codex`), or switch provider';

const NOT_LOGGED_IN =
  'the codex CLI is not signed in — run `codex login` once to sign in with your ChatGPT account, then try again';

export function createCodexCliProvider(opts: CodexCliOptions = {}): AdvisorProvider {
  const binary = opts.binary ?? 'codex';
  const model = opts.model ?? CODEX_DEFAULT_MODEL;
  const effort = opts.effort ?? CODEX_DEFAULT_EFFORT;
  const fast = opts.fast ?? true;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const systemPrompt = opts.systemPrompt ?? ADVISOR_SYSTEM_PROMPT;
  const spawn = opts.spawn ?? defaultSpawn;
  const run = (args: readonly string[], input: string, timeout: number, signal?: AbortSignal, onStdout?: (chunk: string) => void): Promise<RunResult> =>
    runCommand(spawn, binary, args, input, timeout, signal, {
      label: 'codex CLI',
      notFoundMessage: NOT_INSTALLED,
      ...(onStdout ? { onStdout } : {}),
    });

  /** `codex login status` reads a local file — cheap enough to gate every run on. */
  const loginStatus = async (): Promise<'ok' | 'logged-out' | 'missing'> => {
    try {
      const probe = await run(['login', 'status'], '', 15_000);
      return probe.code === 0 ? 'ok' : 'logged-out';
    } catch (err) {
      return (err as Error).message === NOT_INSTALLED ? 'missing' : 'logged-out';
    }
  };

  return {
    id: CODEX_CLI_ID,

    async available(): Promise<boolean> {
      return (await loginStatus()) === 'ok';
    },

    async advise(req: AdvisorRequest, signal?: AbortSignal, onActivity?: ActivityListener): Promise<AdvisorResult> {
      // ~50ms against an eight-minute run, and it converts "exited 1" eight
      // minutes in into the right sentence now. This is also the sentence the
      // availability gate harvests when `available()` said no.
      const status = await loginStatus();
      if (status === 'missing') throw new Error(NOT_INSTALLED);
      if (status === 'logged-out') throw new Error(NOT_LOGGED_IN);

      const args = [
        'exec',
        '--json',
        '--ephemeral',
        '--skip-git-repo-check',
        '--ignore-user-config',
        '--color',
        'never',
        '-s',
        'read-only',
        '-c',
        'model_reasoning_summary=detailed',
        '-c',
        'web_search=disabled',
        '-m',
        model,
        '-c',
        `model_reasoning_effort=${effort}`,
        ...(fast ? ['-c', 'service_tier=fast'] : []),
        systemPrompt,
      ];

      const stream = codexReader(onActivity);
      const started = Date.now();
      const proc = await run(args, buildUserTurn(req.contextDoc, req.question), timeoutMs, signal, stream.read);
      const durationMs = Date.now() - started;

      if (proc.timedOut) {
        throw new Error(
          `codex CLI timed out after ${Math.round(timeoutMs / 1000)}s — raise the timeout, or lower the effort`,
        );
      }
      const failure = stream.state.error;
      if (proc.code !== 0) {
        throw new Error(
          `codex CLI exited ${proc.code ?? 'by signal'}${failure ? ` — ${failure}` : ''}${stderrTail(proc.stderr)}`,
        );
      }
      if (failure && stream.state.answer === undefined) {
        throw new Error(`codex CLI reported an error — ${failure}${stderrTail(proc.stderr)}`);
      }
      if (stream.state.answer === undefined) {
        throw new Error(
          `codex CLI produced no answer — stdout began: ${JSON.stringify(proc.stdout.slice(0, 200))}`,
        );
      }

      const text = stream.state.answer;
      const u = stream.state.usage;
      const usage = {
        // `cached_input_tokens` is a subset of `input_tokens` (verified live:
        // 11554 in / 8064 cached on a warm dossier), so no summing here —
        // unlike claude's three disjoint fields.
        ...(u?.input_tokens !== undefined ? { inputTokens: u.input_tokens } : {}),
        ...(u?.output_tokens !== undefined ? { outputTokens: u.output_tokens } : {}),
        ...(u?.reasoning_output_tokens !== undefined ? { thinkingTokens: u.reasoning_output_tokens } : {}),
        durationMs,
      };
      const structured = parseAdvice(text);

      return {
        text,
        provider: CODEX_CLI_ID,
        model,
        effort,
        ...(structured ? { structured } : {}),
        usage,
      };
    },
  };
}

/** As much of the `codex exec --json` vocabulary as this reads. */
interface CodexEvent {
  type?: string;
  item?: { type?: string; text?: string; message?: string };
  usage?: CodexUsage;
  error?: { message?: string };
  message?: string;
}

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

interface CodexStreamState {
  /** The last `agent_message` item — the answer. */
  answer?: string;
  usage?: CodexUsage;
  /** The last error the stream carried, kept for the exit-code message. */
  error?: string;
}

/**
 * Turn the JSONL stream into activity and a final state, one stdout chunk at a
 * time. Same shape as claude-cli's `activityReader`: stateful because chunk
 * boundaries fall mid-line, silent about anything unrecognised because the
 * event vocabulary is the CLI's to grow.
 *
 * Codex is coarser than claude here, and the consumer already tolerates that:
 * reasoning arrives as whole summary blocks (`item.completed` / `reasoning`),
 * not token deltas, and there are no mid-run token counts at all — usage lands
 * once, on `turn.completed`. The answer is never streamed as activity, per the
 * transcript rule (the box is the reasoning and only the reasoning).
 */
function codexReader(onActivity?: ActivityListener): { read: (chunk: string) => void; state: CodexStreamState } {
  const state: CodexStreamState = {};
  let pending = '';

  const read = (chunk: string): void => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('{')) continue;
      let event: CodexEvent;
      try {
        event = JSON.parse(line) as CodexEvent;
      } catch {
        continue;
      }

      if (event.type === 'item.completed') {
        const item = event.item;
        if (item?.type === 'reasoning' && typeof item.text === 'string' && item.text !== '') {
          onActivity?.({ kind: 'thinking', text: `${item.text}\n\n` });
        } else if (item?.type === 'agent_message' && typeof item.text === 'string') {
          state.answer = item.text;
        } else if (item?.type === 'error' && typeof item.message === 'string') {
          state.error = item.message;
        }
        continue;
      }
      if (event.type === 'turn.completed') {
        if (event.usage) state.usage = event.usage;
        continue;
      }
      if (event.type === 'turn.failed' || event.type === 'error') {
        const message = event.error?.message ?? event.message;
        if (typeof message === 'string' && message !== '') state.error = message;
      }
    }
  };

  return { read, state };
}
